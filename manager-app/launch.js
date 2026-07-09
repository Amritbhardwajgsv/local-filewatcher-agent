// Removes ELECTRON_RUN_AS_NODE (set by VS Code terminals) then spawns Electron.
const { spawn } = require('child_process');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;

const bin = path.join(__dirname, 'node_modules', '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron');

const child = spawn(bin, ['.'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32'
});
child.on('exit', code => process.exit(code || 0));
