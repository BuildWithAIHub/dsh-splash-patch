/**
 * apply-patch.mjs — re-apply the DSH boot-splash patch to whatever app.asar is
 * currently installed.
 *
 * Why this exists: DSH updates replace `resources/app.asar` wholesale, which
 * erases the patch. This script re-injects it into the NEW archive by editing
 * the current files (never by copying an old build), validating every edit with
 * `node --check` before anything is written. If a future DSH version changes the
 * code under an anchor, it reports which anchor vanished and refuses to write —
 * the app keeps working, just without the splash.
 *
 * Usage:
 *   node apply-patch.mjs [--asar PATH] [--out PATH] [--quiet] [--selftest]
 *
 * Exit codes: 0 = patched or already patched, 2 = unsupported (anchor missing),
 *             3 = error (unreadable archive, validation failure, write failure).
 *
 * No network, no telemetry. Reads and writes only `resources/app.asar` and the
 * files in this folder.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
/** Runtime state lives here and is gitignored: logs, backups, test output. */
const STATE_DIR = path.join(ROOT, 'state')
const SPLASH_SOURCE = path.join(HERE, 'boot-splash.html')
const STATUS_FILE = path.join(STATE_DIR, 'status.json')
const LOG_FILE = path.join(STATE_DIR, 'patch.log')
const UNPATCHED_BACKUP = path.join(STATE_DIR, 'app.asar.unpatched.bak')

/** Markers that prove a given file already carries the patch. */
const MAIN_MARKERS = [
  'PATCHED: boot splash state',
  'PATCHED: a SEPARATE fullscreen splash window',
  'PATCHED: the real application page boots',
  'dsh-boot-splash:done',
]
const PRELOAD_MARKERS = ['__DSH_BOOT_FULLSCREEN__', '__DSH_BOOT_SPLASH__']

/**
 * Markers present in ANY patched build (including the hand-applied incremental
 * ones): used to answer "is this archive already patched?" without attempting
 * the anchored edits, whose anchors no longer exist after a patch.
 */
const ALREADY_MAIN_MARKERS = ['bootSplashGate', 'bootSplashPageLoad', 'dsh-boot-splash:done']

const isWindows = process.platform === 'win32'

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch {
    /* logging must never fail the patch */
  }
}

function writeStatus(status) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...status }, null, 2) + '\n',
      'utf8',
    )
  } catch {
    /* status is for a human, not for correctness */
  }
}

/* ------------------------------------------------------------------ asar I/O */

function readArchive(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    if (headerSize <= 0 || headerSize > size - 8) throw new Error(`bad asar header size ${String(headerSize)}`)
    const headerBuf = Buffer.alloc(headerSize)
    fs.readSync(fd, headerBuf, 0, headerSize, 8)
    const jsonLength = headerBuf.readUInt32LE(4)
    const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLength).toString('utf8'))
    return { archive, fd, size, headerSize, header, dataStart: 8 + headerSize, dataLength: size - (8 + headerSize) }
  } catch (error) {
    try {
      fs.closeSync(fd)
    } catch {
      /* already closed */
    }
    throw error
  }
}

function readEntry(archiveInfo, entryPath) {
  const parts = entryPath.split('/')
  let node = archiveInfo.header
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || node.files === undefined) return null
    node = node.files[part]
  }
  if (node === null || node === undefined || node.files !== undefined) return null
  if (node.unpacked === true) {
    try {
      return fs.readFileSync(path.join(archiveInfo.archive + '.unpacked', ...parts), 'utf8')
    } catch {
      return null
    }
  }
  const offset = Number(node.offset)
  const size = Number(node.size)
  const buffer = Buffer.alloc(size)
  fs.readSync(archiveInfo.fd, buffer, 0, size, archiveInfo.dataStart + offset)
  return buffer.toString('utf8')
}

function integrity(buffer) {
  const BLOCK = 4194304
  const blocks = []
  for (let offset = 0; offset < buffer.length; offset += BLOCK) {
    blocks.push(crypto.createHash('sha256').update(buffer.subarray(offset, offset + BLOCK)).digest('hex'))
  }
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    blockSize: BLOCK,
    blocks,
  }
}

function pickleHeader(jsonText) {
  const jsonBuffer = Buffer.from(jsonText, 'utf8')
  const padded = Buffer.alloc(Math.ceil(jsonBuffer.length / 4) * 4)
  jsonBuffer.copy(padded)
  const payload = Buffer.alloc(4 + padded.length)
  payload.writeUInt32LE(jsonBuffer.length, 0)
  padded.copy(payload, 4)
  const headerBuf = Buffer.alloc(4 + payload.length)
  headerBuf.writeUInt32LE(payload.length, 0)
  payload.copy(headerBuf, 4)
  const sizeBuf = Buffer.alloc(8)
  sizeBuf.writeUInt32LE(4, 0)
  sizeBuf.writeUInt32LE(headerBuf.length, 4)
  return { sizeBuf, headerBuf }
}

function ensureDirNode(header, dirPath) {
  if (dirPath === '' || dirPath === undefined) return header
  const parts = dirPath.split('/')
  let node = header
  for (const part of parts) {
    if (node.files === undefined) node.files = {}
    if (node.files[part] === undefined) node.files[part] = { files: {} }
    node = node.files[part]
  }
  return node
}

/** base archive + replaced/added files -> new archive. Data section is copied. */
function writeArchive(baseInfo, outPath, files) {
  const header = JSON.parse(JSON.stringify(baseInfo.header))
  const appended = []
  let offset = baseInfo.dataLength
  for (const file of files) {
    const buffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8')
    const parts = file.path.split('/')
    const name = parts.pop()
    const parent = ensureDirNode(header, parts.join('/'))
    const entry = parent.files[name] ?? {}
    entry.size = buffer.length
    entry.offset = String(offset)
    entry.integrity = integrity(buffer)
    parent.files[name] = entry
    appended.push(buffer)
    offset += buffer.length
  }
  const { sizeBuf, headerBuf } = pickleHeader(JSON.stringify(header))
  const out = fs.openSync(outPath, 'w')
  try {
    fs.writeSync(out, sizeBuf)
    fs.writeSync(out, headerBuf)
    const chunk = 8 * 1024 * 1024
    let position = baseInfo.dataStart
    let remaining = baseInfo.dataLength
    while (remaining > 0) {
      const length = Math.min(chunk, remaining)
      const buffer = Buffer.alloc(length)
      fs.readSync(baseInfo.fd, buffer, 0, length, position)
      fs.writeSync(out, buffer)
      position += length
      remaining -= length
    }
    for (const buffer of appended) fs.writeSync(out, buffer)
  } finally {
    fs.closeSync(out)
  }
}

/* -------------------------------------------------------- code transformation */

function applyEdits(text, edits) {
  let output = text
  const missing = []
  for (const edit of edits) {
    const count = output.split(edit.anchor).length - 1
    if (count !== 1) {
      missing.push(`${edit.label} (found ${String(count)})`)
      continue
    }
    output = output.replace(edit.anchor, edit.replacement)
  }
  return { output, missing }
}

const GATE_STATE = `let mainWindow;
// PATCHED: boot splash state. A separate window plays the clip, the main window
// boots behind it, and the workspace only replaces the splash after the clip
// reports done (or the user skips it).
let bootSplashActive = false;
let bootSplashFinished = false;
let bootSplashResolve = void 0;
let bootSplashWindow = void 0;
let bootSplashPageLoad = Promise.resolve();
const bootSplashGate = new Promise((resolve) => {
	bootSplashResolve = resolve;
});
const finishBootSplash = () => {
	if (bootSplashFinished) return;
	bootSplashFinished = true;
	// The clip is over: remove its window first, then let the workspace in.
	if (bootSplashWindow !== void 0 && !bootSplashWindow.isDestroyed()) bootSplashWindow.close();
	if (mainWindow !== void 0 && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
	bootSplashResolve();
};
`

const SPLASH_VIDEO_HELPER = `\treturn new Response(request.method === "HEAD" ? null : content, { headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" } });
}
/**
 * PATCHED: pick the boot splash clip for this launch.
 *
 * A rotation file is an array of resource file names; launches walk it in order
 * (the counter lives in \`splash-rotation.state\` next to the file). The file is
 * looked up beside the video resources first, then under
 * \`%DSH_HOME%/boot-animation/\`. Without one, the animation plugin's saved
 * selection decides.
 */
async function bootSplashVideoFile() {
	const clips = { "builtin:brand": "brand", "builtin:cyberpunk": "cyberpunk", "builtin:awakening": "awakening", "builtin:startup": "startup" };
	const rotationFiles = [join(process.resourcesPath, "splash-rotation.json")];
	try {
		const home = process.env.DSH_HOME ?? join(app.getPath("home"), ".dsh");
		rotationFiles.push(join(home, "boot-animation", "splash-rotation.json"));
	} catch {
		/* no home path: only the resources file is checked */
	}
	for (const rotationFile of rotationFiles) {
		try {
			const rotation = JSON.parse(await readFile(rotationFile, "utf8"));
			const names = Array.isArray(rotation) ? rotation.filter((name) => typeof name === "string" && /^[A-Za-z0-9._-]+[.]mp4$/.test(name)) : [];
			if (names.length === 0) continue;
			const stateFile = join(dirname(rotationFile), "splash-rotation.state");
			let index = 0;
			try {
				index = Math.abs(Math.trunc(Number(await readFile(stateFile, "utf8")) || 0));
			} catch {
				index = 0;
			}
			const chosen = names[index % names.length];
			try {
				await writeFile(stateFile, String((index + 1) % names.length), "utf8");
			} catch {
				/* without the counter the next launch starts over; the clip still plays */
			}
			return join(process.resourcesPath, chosen);
		} catch {
			/* try the next rotation file */
		}
	}
	try {
		const base = process.env.DSH_HOME ?? join(app.getPath("home"), ".dsh");
		const raw = await readFile(join(base, "boot-animation", "selection.json"), "utf8");
		const parsed = JSON.parse(raw) ?? {};
		const id = parsed.splashClipId ?? parsed.selectedClipId;
		const name = clips[id];
		if (name !== void 0) return join(process.resourcesPath, \`boot-intro-\${name}.mp4\`);
	} catch {
		/* fall through to the default clip */
	}
	return join(process.resourcesPath, "boot-intro-awakening.mp4");
}
`

const IPC_BLOCK = `	// PATCHED: the splash page reports the clip finished (or the user skipped).
	// Either way the workspace is only allowed in afterwards, so the clip is
	// never cut short by a host that booted faster than the video.
	const acceptSplashSignal = (event) => {
		assertDesktopSender(event, ["app"]);
		if (event.senderFrame !== event.sender.mainFrame) return;
		if (bootSplashWindow !== void 0 && !bootSplashWindow.isDestroyed() && event.sender === bootSplashWindow.webContents) {
			finishBootSplash();
			return;
		}
		if (mainWindow !== void 0 && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) finishBootSplash();
	};
	ipcMain.on("dsh-boot-splash:done", acceptSplashSignal);
	ipcMain.on("dsh-boot-splash:skip", acceptSplashSignal);
	// PATCHED: boot animation fullscreen bridge. Only the primary application
	// frame may drive it; the intro covers the whole screen while the animation
	// plugin asks for it, and the window is handed back afterwards.
	ipcMain.handle("dsh-boot-animation:fullscreen-enter", (event) => {
		assertDesktopSender(event, ["app"]);
		const owner = mainWindow;
		if (owner === void 0 || owner.isDestroyed()) return false;
		if (event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return false;
		owner.setFullScreen(true);
		return true;
	});
	ipcMain.handle("dsh-boot-animation:fullscreen-exit", (event) => {
		assertDesktopSender(event, ["app"]);
		const owner = mainWindow;
		if (owner === void 0 || owner.isDestroyed()) return false;
		if (event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame) return false;
		owner.setFullScreen(false);
		return false;
	});
	ipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease) => {`

const SPLASH_WINDOW = `	mainWindow = createMainWindow();
	// PATCHED: a SEPARATE fullscreen splash window plays the clip while the
	// hidden main window loads the real application page in parallel. When the
	// clip ends the splash closes and the already-loaded workspace is revealed —
	// the load is no longer serialized behind the video.
	{
		const splash = new BrowserWindow({
			width: 1280,
			height: 820,
			show: true,
			frame: false,
			fullscreen: true,
			backgroundColor: "#000000",
			webPreferences: {
				preload: appPreload,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				devTools: true
			}
		});
		bootSplashWindow = splash;
		bootSplashActive = true;
		splash.once("closed", () => {
			if (bootSplashWindow === splash) bootSplashWindow = void 0;
			finishBootSplash();
		});
		// Safety net: a broken splash page must never hold the workspace forever.
		setTimeout(finishBootSplash, 30000);
		bootSplashPageLoad = splash.loadURL(bootSplashUrl).catch((error) => {
			console.error("desktop boot splash failed", error);
			finishBootSplash();
		});
	}
`

const SPLASH_URL_CONST = `	const applicationUrl = \`\${SCHEME}://app/\`;
	const bootSplashUrl = \`\${SCHEME}://app/boot-splash.html\`;`

const ENTER_WORKSPACE = `	const enterWorkspace = async ({ activate = true } = {}) => {
		if (quitting) return;
		const window = mainWindow ?? createMainWindow();
		// PATCHED: wait for the boot clip to finish; the app page has been loading
		// in the hidden window meanwhile, so the workspace is ready when it ends.
		if (bootSplashActive) await bootSplashGate;
		await navigateMain(applicationUrl);
		// PATCHED: the splash owned fullscreen; give the window back normally.
		if (!window.isDestroyed() && window.isFullScreen()) window.setFullScreen(false);`

const RECONCILE = `	const reconcileBackend = () => {
		startup ??= (async () => {
			// PATCHED: the real application page boots in the HIDDEN main window
			// while the separate splash window plays the clip, so the workspace is
			// already loading when the clip ends. The splash page must be up first:
			// it records the launch in localStorage for the animation plugin.
			await bootSplashPageLoad;
			await navigateMain(applicationUrl);
			await backend.start(async () => {
				await Promise.all([manager.applyRelease(), prepareHostEnvironment()]);
			});`

const FOCUS_ANCHOR = `	focusPrimaryWindow = () => {
		if (quitting) return;`
const FOCUS_REPLACEMENT = `	focusPrimaryWindow = () => {
		if (quitting) return;
		// PATCHED: while the splash is up, a second launch focuses it — the
		// "first double-click did nothing" report came from a hidden main window.
		if (bootSplashWindow !== void 0 && !bootSplashWindow.isDestroyed()) {
			if (bootSplashWindow.isMinimized()) bootSplashWindow.restore();
			bootSplashWindow.show();
			bootSplashWindow.focus();
			return;
		}`

const WELCOME_ANCHOR = `	const showWelcome = () => {
		if (quitting) return Promise.resolve();`
const WELCOME_REPLACEMENT = `	const showWelcome = () => {
		if (quitting) return Promise.resolve();
		// PATCHED: a first-run welcome replaces the main window, so leave splash fullscreen.
		finishBootSplash();
		if (mainWindow !== void 0 && !mainWindow.isDestroyed()) {
			if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
			mainWindow.hide();
		}`

const MAIN_EDITS = [
  {
    label: 'applicationUrl + splash url',
    anchor: '\tconst applicationUrl = `${SCHEME}://app/`;\n',
    replacement: SPLASH_URL_CONST + '\n',
  },
  {
    label: 'protocol handler async + splash routes',
    anchor: `\tprotocol.handle(SCHEME, (request) => {
\t\tconst url = new URL(request.url);
\t\tif (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
\t\tif (url.hostname === "app") {
\t\t\tif (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/")`,
    replacement: `\tprotocol.handle(SCHEME, async (request) => {
\t\tconst url = new URL(request.url);
\t\tif (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
\t\tif (url.hostname === "app") {
\t\t\tif (url.pathname === "/boot-splash.html") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
\t\t\tif (url.pathname === "/boot-video.mp4") {
\t\t\t\ttry {
\t\t\t\t\tconst bytes = await readFile(await bootSplashVideoFile());
\t\t\t\t\treturn new Response(new Uint8Array(bytes), { headers: { "content-type": "video/mp4", "cache-control": "no-store" } });
\t\t\t\t} catch (error) {
\t\t\t\t\tconsole.error("desktop boot splash video unavailable", error);
\t\t\t\t\treturn new Response(null, { status: 404 });
\t\t\t\t}
\t\t\t}
\t\t\tif (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.startsWith("/assets/")`,
  },
  {
    label: 'serveWebDocument + splash video helper',
    anchor: '\treturn new Response(request.method === "HEAD" ? null : content, { headers: { "content-type": MIME[extname(target)] ?? "application/octet-stream" } });\n}\n',
    replacement: SPLASH_VIDEO_HELPER,
  },
  {
    label: 'splash/fullscreen IPC handlers',
    anchor: '\tipcMain.handle(DESKTOP_IPC.browserRelease, (event, lease) => {',
    replacement: IPC_BLOCK,
  },
  {
    label: 'splash window creation',
    anchor: '\tmainWindow = createMainWindow();\n',
    replacement: SPLASH_WINDOW,
  },
  {
    label: 'workspace waits for the splash',
    anchor: `\tconst enterWorkspace = async ({ activate = true } = {}) => {
\t\tif (quitting) return;
\t\tconst window = mainWindow ?? createMainWindow();
\t\tawait navigateMain(applicationUrl);`,
    replacement: ENTER_WORKSPACE,
  },
  {
    label: 'parallel app load',
    anchor: `\tconst reconcileBackend = () => {
\t\tstartup ??= (async () => {
\t\t\tawait navigateMain(applicationUrl);
\t\t\tawait backend.start(async () => {
\t\t\t\tawait Promise.all([manager.applyRelease(), prepareHostEnvironment()]);
\t\t\t});`,
    replacement: RECONCILE,
  },
  {
    label: 'focus splash on second launch',
    anchor: FOCUS_ANCHOR,
    replacement: FOCUS_REPLACEMENT,
  },
  {
    label: 'welcome replaces the splash',
    anchor: WELCOME_ANCHOR,
    replacement: WELCOME_REPLACEMENT,
  },
  {
    label: 'splash gate state',
    anchor: 'let mainWindow;\n',
    replacement: GATE_STATE,
  },
]

const PRELOAD_EDITS = [
  {
    label: 'boot bridges',
    anchor: 'exposeInMainWorld("dshDesktop", location.protocol === `dsh-app:` && location.hostname === "app" && process.isMainFrame ? createProductApi() : { protocolVersion: 1 });\n',
    replacement:
      'exposeInMainWorld("dshDesktop", location.protocol === `dsh-app:` && location.hostname === "app" && process.isMainFrame ? createProductApi() : { protocolVersion: 1 });\n' +
      '// PATCHED: the boot animation plugin asks for real window fullscreen and the\n' +
      '// splash page reports the clip finished. Both are restricted to the local app\n' +
      '// document, so a guest page can never drive the desktop window.\n' +
      'if (location.protocol === `dsh-app:` && location.hostname === "app" && process.isMainFrame) {\n' +
      '\telectron.contextBridge.exposeInMainWorld("__DSH_BOOT_FULLSCREEN__", {\n' +
      '\t\tenter: () => electron.ipcRenderer.invoke("dsh-boot-animation:fullscreen-enter"),\n' +
      '\t\texit: () => electron.ipcRenderer.invoke("dsh-boot-animation:fullscreen-exit")\n' +
      '\t});\n' +
      '\telectron.contextBridge.exposeInMainWorld("__DSH_BOOT_SPLASH__", {\n' +
      '\t\tdone: () => electron.ipcRenderer.send("dsh-boot-splash:done"),\n' +
      '\t\tskip: () => electron.ipcRenderer.send("dsh-boot-splash:skip")\n' +
      '\t});\n' +
      '}\n',
  },
]

/** Check patched sources parse, in a throwaway package with `type: module`. */
function validateSyntax(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-check-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8')
    for (const file of files) {
      const target = path.join(dir, file.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content, 'utf8')
      try {
        execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
      } catch (error) {
        // Keep the failing output so a maintainer can see WHAT broke, not just
        // "SyntaxError"; the file name is written next to the patcher.
        const dump = path.join(STATE_DIR, `validation-failure-${file.path.replace(/[^a-z0-9.]/gi, '_')}`)
        try {
          fs.mkdirSync(STATE_DIR, { recursive: true })
          fs.copyFileSync(target, dump)
        } catch {
          /* the message below still says what failed */
        }
        const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : String(error?.message ?? error)
        throw new Error(`patched ${file.path} does not parse (dump: ${dump})\n${stderr}`)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------- patching */

function patchArchive({ asarPath, outPath, quiet }) {
  const say = (message) => {
    if (!quiet) console.log(message)
  }
  const info = readArchive(asarPath)
  try {
    const mainText = readEntry(info, 'lib/main.js')
    const preloadText = readEntry(info, 'lib/preload-app.cjs')
    const splashText = readEntry(info, 'renderer/boot-splash.html')
    if (mainText === null || preloadText === null) {
      return { code: 3, action: 'error', detail: 'archive does not contain lib/main.js or lib/preload-app.cjs' }
    }
    const already =
      ALREADY_MAIN_MARKERS.every((marker) => mainText.includes(marker)) &&
      PRELOAD_MARKERS.every((marker) => preloadText.includes(marker)) &&
      splashText !== null
    if (already) {
      say('already patched')
      return { code: 0, action: 'already', detail: 'the archive already carries the splash patch' }
    }

    const splashSource = fs.readFileSync(SPLASH_SOURCE, 'utf8')
    const main = applyEdits(mainText, MAIN_EDITS)
    const preload = applyEdits(preloadText, PRELOAD_EDITS)
    const missing = [...main.missing, ...preload.missing]
    if (missing.length > 0) {
      const detail = 'missing anchors: ' + missing.join('; ')
      say('UNSUPPORTED: ' + detail)
      return { code: 2, action: 'unsupported', detail }
    }
    validateSyntax([
      { path: 'main.js', content: main.output },
      { path: 'preload-app.cjs', content: preload.output },
    ])
    const target = outPath ?? path.join(path.dirname(asarPath), 'app.asar.patched.tmp')
    writeArchive(info, target, [
      { path: 'lib/main.js', content: main.output },
      { path: 'lib/preload-app.cjs', content: preload.output },
      { path: 'renderer/boot-splash.html', content: splashSource },
    ])
    const verify = readArchive(target)
    try {
      const checkMain = readEntry(verify, 'lib/main.js') ?? ''
      const checkPreload = readEntry(verify, 'lib/preload-app.cjs') ?? ''
      if (!MAIN_MARKERS.every((marker) => checkMain.includes(marker))) throw new Error('patched main.js failed its marker check')
      if (!PRELOAD_MARKERS.every((marker) => checkPreload.includes(marker))) throw new Error('patched preload failed its marker check')
    } finally {
      fs.closeSync(verify.fd)
    }
    say(`patched -> ${target} (${String(fs.statSync(target).size)} bytes)`)
    return { code: 0, action: 'patched', detail: target }
  } finally {
    fs.closeSync(info.fd)
  }
}

const ROTATION_SOURCE = path.join(HERE, 'splash-rotation.json')

/**
 * Install the rotation preference next to the archive, if this patcher ships one.
 * Kept next to the archive (resources\) so the desktop process finds it without
 * knowing DSH_HOME; the patcher re-installs it after every DSH update.
 */
function installRotationFile(asarPath, say) {
  if (!fs.existsSync(ROTATION_SOURCE)) return
  const target = path.join(path.dirname(asarPath), 'splash-rotation.json')
  try {
    fs.copyFileSync(ROTATION_SOURCE, target)
    say(`installed splash rotation: ${target}`)
  } catch (error) {
    say(`could not install splash rotation: ${String(error?.message ?? error)}`)
  }
}

function installInPlace(asarPath, quiet) {
  const say = (message) => {
    if (!quiet) console.log(message)
  }
  const tmp = path.join(path.dirname(asarPath), 'app.asar.patched.tmp')
  try {
    if (!fs.existsSync(UNPATCHED_BACKUP)) {
      fs.copyFileSync(asarPath, UNPATCHED_BACKUP)
      say(`kept an unpatched backup: ${UNPATCHED_BACKUP}`)
    }
    fs.copyFileSync(tmp, asarPath)
    installRotationFile(asarPath, say)
    say('installed patched app.asar (takes effect on the next DSH start)')
    return { code: 0, action: 'patched', detail: 'installed in place' }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* already moved or never written */
    }
  }
}

function parseArgs(argv) {
  const options = { quiet: false, selftest: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--quiet') options.quiet = true
    else if (arg === '--selftest') options.selftest = true
    else if (arg === '--asar') options.asar = argv[++index]
    else if (arg.startsWith('--asar=')) options.asar = arg.slice('--asar='.length)
    else if (arg === '--out') options.out = argv[++index]
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--base') options.base = argv[++index]
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length)
  }
  return options
}

function defaultAsar() {
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
    if (typeof config.asar === 'string' && config.asar !== '') return config.asar
  } catch {
    /* config.json is optional */
  }
  const candidates = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
      : null,
    process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources', 'app.asar')
      : null,
    'C:/Program Files/DeepSeek Harness/resources/app.asar',
    'C:/Program Files (x86)/DeepSeek Harness/resources/app.asar',
  ].filter((entry) => typeof entry === 'string')
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

/* ------------------------------------------------------------------ self test */

function copyBase(source, dest) {
  fs.copyFileSync(source, dest)
  return dest
}

function runSelftest(options = {}) {
  const report = []
  const check = (ok, label, detail = '') => {
    report.push({ ok, label })
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `\n         ${detail}`}`)
  }
  // A pristine app.asar is the only fixture that can exercise the real anchors.
  // It is NOT redistributed: point --base at a copy from your own install.
  const base = options.base ?? path.join(ROOT, 'test', 'app.asar.pristine')
  if (!fs.existsSync(base)) {
    console.error(
      'selftest: no pristine archive to test against.\n' +
        '          copy resources\\app.asar from a fresh DSH install to\n' +
        '          test\\app.asar.pristine (it is gitignored), or pass --base <path>.\n' +
        `          looked for: ${base}`,
    )
    process.exit(1)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-selftest-'))
  try {
    // 1) fresh patch from the pristine archive
    const fresh = copyBase(base, path.join(dir, 'fresh.asar'))
    const patched = patchArchive({ asarPath: fresh, outPath: path.join(dir, 'fresh.patched.asar'), quiet: true })
    check(patched.code === 0 && patched.action === 'patched', 'a pristine archive is patched', JSON.stringify(patched))
    const out = path.join(dir, 'fresh.patched.asar')
    if (fs.existsSync(out)) {
      const info = readArchive(out)
      try {
        const mainText = readEntry(info, 'lib/main.js') ?? ''
        const preloadText = readEntry(info, 'lib/preload-app.cjs') ?? ''
        const splashText = readEntry(info, 'renderer/boot-splash.html') ?? ''
        check(MAIN_MARKERS.every((marker) => mainText.includes(marker)), 'the patched main.js carries every marker')
        check(
          PRELOAD_MARKERS.every((marker) => preloadText.includes(marker)),
          'the patched preload carries both bridges',
        )
        check(splashText.includes('dsh-boot-animation:desktop-splash'), 'the splash page is embedded')
      } finally {
        fs.closeSync(info.fd)
      }

      // 2) idempotent: patching the patch is a no-op
      const again = copyBase(out, path.join(dir, 'again.asar'))
      const second = patchArchive({ asarPath: again, outPath: path.join(dir, 'again.patched.asar'), quiet: true })
      check(second.code === 0 && second.action === 'already', 'patching an already patched archive is a no-op')
      check(!fs.existsSync(path.join(dir, 'again.patched.asar')), 'the no-op writes no output archive')
    }

    // 3) unsupported: a changed anchor must refuse to write
    const broken = copyBase(base, path.join(dir, 'broken.asar'))
    {
      const info = readArchive(broken)
      try {
        const mainText = readEntry(info, 'lib/main.js') ?? ''
        const mutated = mainText.replace('let mainWindow;\n', 'let mainWindowChanged;\n')
        writeArchive(info, path.join(dir, 'broken.fixture.asar'), [{ path: 'lib/main.js', content: mutated }])
      } finally {
        fs.closeSync(info.fd)
      }
    }
    const refused = patchArchive({
      asarPath: path.join(dir, 'broken.fixture.asar'),
      outPath: path.join(dir, 'broken.patched.asar'),
      quiet: true,
    })
    check(refused.code === 2 && refused.action === 'unsupported', 'a changed anchor is refused (exit 2)')
    check(!fs.existsSync(path.join(dir, 'broken.patched.asar')), 'the refused patch writes no archive')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  const failed = report.filter((entry) => !entry.ok)
  console.log('')
  if (failed.length === 0) {
    console.log(`all ${String(report.length)} checks passed`)
    process.exit(0)
  }
  console.log(`${String(failed.length)} of ${String(report.length)} check(s) failed`)
  process.exit(1)
}

/* ----------------------------------------------------------------------- main */

const options = parseArgs(process.argv.slice(2))
if (options.selftest) runSelftest(options)

const asarPath = options.asar ?? defaultAsar()
if (!fs.existsSync(asarPath)) {
  const detail = `app.asar not found: ${asarPath}`
  writeStatus({ action: 'error', code: 3, detail })
  log(detail)
  if (!options.quiet) console.error(detail)
  process.exit(3)
}

try {
  if (options.out !== undefined) {
    const result = patchArchive({ asarPath, outPath: options.out, quiet: options.quiet })
    writeStatus(result)
    log(`${result.action}: ${result.detail ?? ''}`)
    process.exit(result.code)
  }

  // The live path: patch to a temp file, then install it.
  const tmp = path.join(path.dirname(asarPath), 'app.asar.patched.tmp')
  const result = patchArchive({ asarPath, outPath: tmp, quiet: options.quiet })
  if (result.code !== 0) {
    writeStatus(result)
    log(`${result.action}: ${result.detail ?? ''}`)
    process.exit(result.code)
  }
  if (result.action === 'already') {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* nothing to remove */
    }
    writeStatus(result)
    log('already patched')
    process.exit(0)
  }
  const installed = installInPlace(asarPath, options.quiet)
  writeStatus({ ...installed, version: readInstalledVersion(asarPath) })
  log(`patched and installed (${readInstalledVersion(asarPath)})`)
  process.exit(0)
} catch (error) {
  const detail = String(error?.stack ?? error)
  notifyFatal(detail, options.quiet)
  process.exit(3)
}

function notifyFatal(detail, quiet) {
  writeStatus({ action: 'error', code: 3, detail })
  log('ERROR: ' + detail)
  if (!quiet) console.error(detail)
}

function readInstalledVersion(archive) {
  try {
    const info = readArchive(archive)
    try {
      const text = readEntry(info, 'package.json')
      return text === null ? 'unknown' : (JSON.parse(text).version ?? 'unknown')
    } finally {
      fs.closeSync(info.fd)
    }
  } catch {
    return 'unknown'
  }
}
