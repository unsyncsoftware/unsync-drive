require('dotenv').config();

const express    = require('express');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs-extra');
const mime       = require('mime-types');
const multer     = require('multer');
const { v4: uuid } = require('uuid');
const { v2: webdav } = require('webdav-server');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || '3700');
const STORAGE    = path.resolve(process.env.STORAGE_ROOT || path.join(__dirname, 'storage'));
const JWT_SECRET = process.env.JWT_SECRET;
const USERNAME   = process.env.DRIVE_USERNAME;
const PASSWORD   = process.env.DRIVE_PASSWORD;
const TEMP_DIR   = path.join(__dirname, '.tmp');

if (!JWT_SECRET || !USERNAME || !PASSWORD) {
  console.error('\n  ❌  Missing required .env values. Run: node setup.js\n');
  process.exit(1);
}

fs.ensureDirSync(STORAGE);
fs.ensureDirSync(TEMP_DIR);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function safePath(rel = '/') {
  const clean = rel.replace(/\.\./g, '').replace(/^\/+/, '');
  const abs   = path.resolve(STORAGE, clean);
  if (!abs.startsWith(STORAGE)) {
    throw Object.assign(new Error('Access denied'), { status: 400 });
  }
  return abs;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

async function statEntry(dir, name) {
  const full = path.join(dir, name);
  const stat = await fs.stat(full);
  return {
    name,
    isDir    : stat.isDirectory(),
    size     : stat.size,
    modified : stat.mtime.toISOString(),
    mime     : stat.isDirectory() ? null : (mime.lookup(name) || 'application/octet-stream'),
  };
}

// ─────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== USERNAME || password !== PASSWORD) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// ─────────────────────────────────────────────────────────────
// File API
// ─────────────────────────────────────────────────────────────

// List directory
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const dir     = safePath(req.query.path);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files   = await Promise.all(entries.map(e => statEntry(dir, e.name)));
    res.json(files);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Download
app.get('/api/download', requireAuth, async (req, res) => {
  try {
    const file = safePath(req.query.path);
    const stat = await fs.stat(file);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot download a folder' });
    res.download(file);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Create folder
app.post('/api/mkdir', requireAuth, async (req, res) => {
  try {
    await fs.ensureDir(safePath(req.body.path));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Delete (file or folder)
app.delete('/api/files', requireAuth, async (req, res) => {
  try {
    await fs.remove(safePath(req.body.path));
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Rename / Move
app.post('/api/move', requireAuth, async (req, res) => {
  try {
    await fs.move(safePath(req.body.from), safePath(req.body.to), { overwrite: false });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Chunked Upload
// Client sends chunks sequentially: each is a FormData POST
// with fields: uploadId, chunkIndex, totalChunks, filename, destPath
// ─────────────────────────────────────────────────────────────
const chunkUpload = multer({ storage: multer.memoryStorage() });

app.post('/api/upload/chunk', requireAuth, chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, filename, destPath } = req.body;
    const total    = parseInt(totalChunks);
    const chunkDir = path.join(TEMP_DIR, uploadId || uuid());

    await fs.ensureDir(chunkDir);
    await fs.writeFile(path.join(chunkDir, `chunk-${chunkIndex}`), req.file.buffer);

    const received = (await fs.readdir(chunkDir)).length;

    if (received === total) {
      // All chunks in — assemble
      const dest = safePath(path.join(destPath || '/', filename));
      await fs.ensureDir(path.dirname(dest));

      const out = fs.createWriteStream(dest);
      await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        (async () => {
          for (let i = 0; i < total; i++) {
            const buf = await fs.readFile(path.join(chunkDir, `chunk-${i}`));
            out.write(buf);
          }
          out.end();
        })().catch(reject);
      });

      await fs.remove(chunkDir);
      return res.json({ ok: true, complete: true });
    }

    res.json({ ok: true, complete: false, received });
  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Storage info
// ─────────────────────────────────────────────────────────────
app.get('/api/info', requireAuth, async (req, res) => {
  try {
    // Walk storage root to get total size
    let totalSize = 0;
    let fileCount = 0;
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else {
          const stat = await fs.stat(full);
          totalSize += stat.size;
          fileCount++;
        }
      }
    };
    await walk(STORAGE);
    res.json({ totalSize, fileCount, storagePath: STORAGE });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// WebDAV — maps as a network drive in Windows File Explorer
// Map drive via: \\COMPUTER\DavWWWRoot\IP:PORT\dav
// Or: Map Network Drive → http://IP:PORT/dav
// ─────────────────────────────────────────────────────────────
const userManager      = new webdav.SimpleUserManager();
const davUser          = userManager.addUser(USERNAME, PASSWORD, false);
const privilegeManager = new webdav.SimplePathPrivilegeManager();
privilegeManager.setRights(davUser, '/', ['all']);

const davServer = new webdav.WebDAVServer({
  userManager,
  privilegeManager,
  requireAuthentification: true,
  httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, "Unsync Drive"),
});

davServer.setFileSystem('/', new webdav.PhysicalFileSystem(STORAGE), (success) => {
  if (!success) {
    console.error('Failed to mount WebDAV filesystem');
    process.exit(1);
  }

  app.use(webdav.extensions.express('/dav', davServer));

  app.listen(PORT, '0.0.0.0', () => {
    const line = '─'.repeat(46);
    console.log(`\n  ┌${line}┐`);
    console.log(`  │           Unsync Drive  v1.0.0              │`);
    console.log(`  └${line}┘`);
    console.log(`\n  Web UI   →  http://0.0.0.0:${PORT}`);
    console.log(`  WebDAV   →  http://0.0.0.0:${PORT}/dav`);
    console.log(`  Storage  →  ${STORAGE}`);
    console.log(`\n  Map drive in Windows:`);
    console.log(`  → Map Network Drive → http://<aorus-ip>:${PORT}/dav\n`);
  });
});
