/**
 * Runs inside `npm install` on Vercel only (VERCEL is set by the platform). Installs and builds the
 * API workspace, then applies pending migrations, so the deployed function ships with a schema that
 * matches the code. A local `npm install` never touches the database.
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

if (!process.env.VERCEL) process.exit(0);

const root = path.resolve(__dirname, '..');
const run = (command, args) => {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
};

run('npm', ['--prefix', 'api', 'ci', '--no-audit', '--no-fund']);
run('npm', ['--prefix', 'api', 'run', 'build']);
if (process.env.DATABASE_URL && existsSync(path.join(root, 'api', 'src', 'database', 'migrations'))) {
  run('npm', ['--prefix', 'api', 'run', 'db:migrate']);
} else {
  console.log('> skipping db:migrate (DATABASE_URL is not set for this build)');
}
