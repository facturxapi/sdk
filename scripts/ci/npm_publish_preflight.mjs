#!/usr/bin/env node
/**
 * Pre-publication checks of an npm package, run by .github/workflows/publish-npm.yml BEFORE anything leaves the runner.
 *   node scripts/ci/npm_publish_preflight.mjs <package dir> <expected name> <expected version> [--registry]
 * Prints « PREFLIGHT_OK … » (exit 0) or « PREFLIGHT_REFUSED: <reason> » (exit 1). No secret is read, nothing is published.
 * Env: GITHUB_REPOSITORY (owner/repo the repository.url must name; default facturxapi/sdk).
 * --registry also refuses a version that already exists on the registry (`npm view <name>@<version> version` succeeds).
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const [dir, name, version, ...flags] = process.argv.slice(2)
const refuse = (reason) => { console.log(`PREFLIGHT_REFUSED: ${reason}`); process.exit(1) }
if (!dir || !name || !version) refuse('usage: npm_publish_preflight.mjs <dir> <expected name> <expected version> [--registry]')

let pkg
try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (error) { refuse(`package.json unreadable in ${dir}: ${error.message}`) }

if (pkg.name !== name) refuse(`package name « ${pkg.name} » is not the expected « ${name} »`)
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) refuse(`expected version « ${version} » is not a semver`)
if (pkg.version !== version) refuse(`package.json version « ${pkg.version} » is not the requested « ${version} »`)
if (pkg.private === true) refuse('package.json has "private": true (npm refuses to stage or publish it)')
if (typeof pkg.license !== 'string' || pkg.license.trim() === '') refuse('package.json has no "license" (a founder decision, see FOUNDER-CHECKLIST.md)')
if (/decid|todo|tbd|placeholder/i.test(pkg.license)) refuse(`package.json license « ${pkg.license} » is still a placeholder (a founder decision, see FOUNDER-CHECKLIST.md)`)

const repo = process.env.GITHUB_REPOSITORY || 'facturxapi/sdk'
const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
const norm = String(url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
if (norm !== `https://github.com/${repo}`) refuse(`repository.url « ${url ?? 'absent'} » must name https://github.com/${repo} exactly (npm trusted publishing compares it)`)
const rel = dir.replace(/^\.\//, '').replace(/\/$/, '')
if (typeof pkg.repository === 'object' && pkg.repository.directory !== rel) refuse(`repository.directory « ${pkg.repository.directory ?? 'absent'} » must be « ${rel} »`)
if (name.startsWith('@') && pkg.publishConfig?.access !== 'public') refuse('a scoped package needs "publishConfig": { "access": "public" }')
if (!pkg.engines?.node) refuse('package.json has no engines.node')
if (!Array.isArray(pkg.files) || pkg.files.length === 0) refuse('package.json has no "files" whitelist (the tarball would take everything not ignored)')

const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' })
if (pack.status !== 0) refuse(`npm pack --dry-run failed: ${(pack.stderr || pack.stdout).trim().split('\n')[0]}`)
let files
try { files = JSON.parse(pack.stdout)[0].files.map((f) => f.path) } catch { refuse('npm pack --dry-run answered something unreadable') }
for (const must of ['package.json', 'README.md']) if (!files.includes(must)) refuse(`the tarball does not contain ${must}`)
const bad = files.filter((f) => /(^|\/)(test|tests|fixtures|cassettes|traces|node_modules)\//.test(f) || /(^|\/)\.(env|npmrc)/.test(f) || /\.(pem|key|p12)$/.test(f))
if (bad.length) refuse(`the tarball would contain files that must not ship: ${bad.slice(0, 5).join(', ')}`)

if (flags.includes('--registry')) {
  const view = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' })
  if (view.status === 0 && view.stdout.trim() !== '') refuse(`${name}@${version} already exists on the registry (a version can never be published twice)`)
}
console.log(`PREFLIGHT_OK ${name}@${version}: ${files.length} files in the tarball, license ${pkg.license}, repository ${norm} (${rel})`)
