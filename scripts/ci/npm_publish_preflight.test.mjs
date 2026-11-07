// node --test scripts/ci/npm_publish_preflight.test.mjs — the preflight on throw-away packages (real `npm pack --dry-run`, `npm view` shimmed, no network).
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'npm_publish_preflight.mjs')
const REAL_NPM = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim()
const GOOD = {
  name: '@facturxapi/sdk', version: '0.1.0', license: 'MIT', type: 'module',
  repository: { type: 'git', url: 'git+https://github.com/facturxapi/sdk.git', directory: 'node' },
  publishConfig: { access: 'public' }, engines: { node: '>=18.17' }, files: ['src/', 'README.md'],
}

function make(overrides = {}, { extraFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-'))
  const dir = join(root, 'node')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.js'), 'export {}\n')
  writeFileSync(join(dir, 'README.md'), '# sdk\n')
  for (const [rel, body] of Object.entries(extraFiles)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body) }
  const pkg = { ...GOOD, ...overrides }
  for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete pkg[key]
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return { root, dir }
}
function shim(root, viewExit) {
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nif [ "$1" = view ]; then [ ${viewExit} = 0 ] && echo "$2" | sed 's/.*@//'; exit ${viewExit}; fi\nexec ${REAL_NPM} "$@"\n`)
  chmodSync(join(bin, 'npm'), 0o755)
  return bin
}
function run(made, args, { viewExit, env = {} } = {}) {
  // the script is called with the package dir RELATIVE to the repo root, as the workflow does: cwd = root, dir = node
  const bin = viewExit === undefined ? null : shim(made.root, viewExit)
  const r = spawnSync('node', [SCRIPT, 'node', ...args], {
    cwd: made.root, encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'facturxapi/sdk', ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}), ...env },
  })
  return { code: r.status, out: r.stdout.trim() }
}

test('a complete package passes and says what it ships', () => {
  const r = run(make(), ['@facturxapi/sdk', '0.1.0'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^PREFLIGHT_OK @facturxapi\/sdk@0\.1\.0: 3 files in the tarball, license MIT/)
})

for (const [label, overrides, expected] of [
  ['"private": true', { private: true }, /"private": true/],
  ['no license', { license: undefined }, /no "license"/],
  ['an empty license', { license: ' ' }, /no "license"/],
  ['a placeholder license', { license: 'TO-BE-DECIDED-BY-FOUNDER' }, /still a placeholder/],
  ['another version than requested', { version: '0.1.1' }, /version « 0\.1\.1 » is not the requested « 0\.1\.0 »/],
  ['another name', { name: '@facturxapi/other' }, /is not the expected/],
  ['no repository', { repository: undefined }, /repository\.url « absent »/],
  ['a repository naming another repo', { repository: { type: 'git', url: 'git+https://github.com/someone/other.git', directory: 'node' } }, /must name https:\/\/github\.com\/facturxapi\/sdk exactly/],
  ['a wrong repository.directory', { repository: { ...GOOD.repository, directory: 'mcp' } }, /repository\.directory « mcp » must be « node »/],
  ['a scoped package without public access', { publishConfig: undefined }, /publishConfig/],
  ['no engines.node', { engines: undefined }, /engines\.node/],
  ['no files whitelist', { files: undefined }, /no "files" whitelist/],
]) {
  test(`refuses ${label}`, () => {
    const r = run(make(overrides), ['@facturxapi/sdk', '0.1.0'])
    assert.equal(r.code, 1)
    assert.match(r.out, /^PREFLIGHT_REFUSED: /)
    assert.match(r.out, expected)
  })
}

test('refuses a tarball that would ship tests or secrets', () => {
  const r = run(make({ files: ['src/', 'test/', 'README.md'] }, { extraFiles: { 'test/fixtures/x.json': '{}' } }), ['@facturxapi/sdk', '0.1.0'])
  assert.equal(r.code, 1)
  assert.match(r.out, /files that must not ship: test\/fixtures\/x\.json/)
  const s = run(make({ files: ['src/', '.env', 'README.md'] }, { extraFiles: { '.env': 'TOKEN=x\n' } }), ['@facturxapi/sdk', '0.1.0'])
  assert.equal(s.code, 1)
  assert.match(s.out, /\.env/)
})

test('refuses a bad expected version and a missing argument', () => {
  assert.match(run(make(), ['@facturxapi/sdk', 'latest']).out, /not a semver/)
  assert.match(run(make(), ['@facturxapi/sdk']).out, /usage/)
})

test('--registry refuses a version that already exists, accepts one that does not', () => {
  const taken = run(make(), ['@facturxapi/sdk', '0.1.0', '--registry'], { viewExit: 0 })
  assert.equal(taken.code, 1)
  assert.match(taken.out, /already exists on the registry/)
  const free = run(make(), ['@facturxapi/sdk', '0.1.0', '--registry'], { viewExit: 1 })
  assert.equal(free.code, 0, free.out)
})

test('without --registry the registry is never asked', () => {
  const r = run(make(), ['@facturxapi/sdk', '0.1.0'], { viewExit: 0 })
  assert.equal(r.code, 0, r.out)
})
