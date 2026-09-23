import path from 'node:path'

import { refToRelative } from '@pnpm/deps.path'
import type {
  PackageSnapshot,
  PackageSnapshots,
  ProjectSnapshot,
} from '@pnpm/lockfile.types'
import { refIsLocalDirectory } from '@pnpm/lockfile.utils'
import { safeReadPackageJsonFromDir } from '@pnpm/pkg-manifest.reader'
import type { DirectoryResolution, WorkspacePackages } from '@pnpm/resolving.resolver-base'
import {
  DEPENDENCIES_FIELDS,
  DEPENDENCIES_OR_PEER_FIELDS,
  type DependencyManifest,
  type ProjectManifest,
} from '@pnpm/types'
import semver from 'semver'
import getVersionSelectorType from 'version-selector-type'

export interface CheckLinkedPackagesResult {
  upToDate: boolean
  detailedReason?: string
}

export async function checkLinkedPackagesAreUpToDate (
  {
    linkWorkspacePackages,
    manifestsByDir,
    workspacePackages,
    lockfilePackages,
    lockfileDir,
  }: {
    linkWorkspacePackages: boolean
    manifestsByDir: Record<string, DependencyManifest>
    workspacePackages?: WorkspacePackages
    lockfilePackages?: PackageSnapshots
    lockfileDir: string
  },
  project: {
    dir: string
    manifest: ProjectManifest
    snapshot: ProjectSnapshot
  }
): Promise<CheckLinkedPackagesResult> {
  const depEntries: Array<{ depField: (typeof DEPENDENCIES_FIELDS)[number], depName: string }> = []
  for (const depField of DEPENDENCIES_FIELDS) {
    const lockfileDeps = project.snapshot[depField]
    const manifestDeps = project.manifest[depField]
    if ((lockfileDeps == null) || (manifestDeps == null)) continue
    for (const depName of Object.keys(lockfileDeps)) {
      if (manifestDeps[depName]) {
        depEntries.push({ depField, depName })
      }
    }
  }

  const results = await Promise.all(
    depEntries.map(async ({ depField, depName }): Promise<CheckLinkedPackagesResult> => {
      const currentSpec = project.manifest[depField]![depName]
      const lockfileRef = project.snapshot[depField]![depName]
      if (refIsLocalDirectory(project.snapshot.specifiers[depName])) {
        // When a file: specifier resolves to link: in the lockfile
        // (e.g. injected self-references), it's a local link with no
        // entry in the packages section. Treat it as up-to-date.
        if (lockfileRef.startsWith('link:')) return { upToDate: true }
        const depPath = refToRelative(lockfileRef, depName)
        if (depPath == null) {
          return {
            upToDate: false,
            detailedReason: `Local directory dependency "${depName}" has invalid lockfile reference "${lockfileRef}"`,
          }
        }
        const localDepResult = await checkLocalFileDepUpToDate(lockfileDir, lockfilePackages?.[depPath], depName)
        if (!localDepResult.upToDate) {
          return localDepResult
        }
        return { upToDate: true }
      }
      const isLinked = lockfileRef.startsWith('link:')
      if (
        isLinked &&
        (
          currentSpec.startsWith('link:') ||
          currentSpec.startsWith('file:') ||
          currentSpec.startsWith('workspace:.')
        )
      ) {
        return { upToDate: true }
      }
      // https://github.com/pnpm/pnpm/issues/6592
      // if the dependency is linked and the specified version type is tag, we consider it to be up-to-date to skip full resolution.
      if (isLinked && getVersionSelectorType(currentSpec)?.type === 'tag') {
        return { upToDate: true }
      }
      const linkedDir = isLinked
        ? path.join(project.dir, lockfileRef.slice(5))
        : workspacePackages?.get(depName)?.get(lockfileRef)?.rootDir
      if (!linkedDir) {
        if (!isLinked && workspacePackages?.has(depName)) {
          const pkgs = Array.from(workspacePackages.get(depName)!.values())
          const availableRange = getVersionRange(currentSpec)
          const matchingPkg = pkgs.find(p =>
            availableRange === '*' || availableRange === '^' || availableRange === '~' ||
            semver.satisfies(p.manifest.version, availableRange, { loose: true })
          )
          if (matchingPkg && (linkWorkspacePackages || currentSpec.startsWith('workspace:'))) {
            return {
              upToDate: false,
              detailedReason: `Workspace package "${depName}" (${matchingPkg.manifest.version}) satisfies range "${currentSpec}" but is not linked in lockfile`,
            }
          }
        }
        return { upToDate: true }
      }
      if (!linkWorkspacePackages && !currentSpec.startsWith('workspace:')) {
        // we found a linked dir, but we don't want to use it, because it's not specified as a
        // workspace:x.x.x dependency
        return { upToDate: true }
      }
      const linkedPkg = manifestsByDir[linkedDir] ?? await safeReadPackageJsonFromDir(linkedDir)
      const availableRange = getVersionRange(currentSpec)
      // This should pass the same options to semver as @pnpm/resolving.npm-resolver
      const localPackageSatisfiesRange = availableRange === '*' || availableRange === '^' || availableRange === '~' ||
        Boolean(linkedPkg && semver.satisfies(linkedPkg.version, availableRange, { loose: true }))
      if (isLinked !== localPackageSatisfiesRange) {
        const detailedReason = isLinked
          ? `Linked workspace package "${depName}" (${linkedPkg?.version ?? 'unknown'}) does not satisfy range "${currentSpec}"`
          : `Workspace package "${depName}" (${linkedPkg?.version ?? 'unknown'}) satisfies range "${currentSpec}" but is not linked in lockfile`
        return {
          upToDate: false,
          detailedReason,
        }
      }
      return { upToDate: true }
    })
  )

  return results.find((r) => !r.upToDate) ?? { upToDate: true }
}

export async function linkedPackagesAreUpToDate (
  opts: {
    linkWorkspacePackages: boolean
    manifestsByDir: Record<string, DependencyManifest>
    workspacePackages?: WorkspacePackages
    lockfilePackages?: PackageSnapshots
    lockfileDir: string
  },
  project: {
    dir: string
    manifest: ProjectManifest
    snapshot: ProjectSnapshot
  }
): Promise<boolean> {
  const result = await checkLinkedPackagesAreUpToDate(opts, project)
  return result.upToDate
}

async function checkLocalFileDepUpToDate (
  lockfileDir: string,
  pkgSnapshot: PackageSnapshot | undefined,
  depName: string
): Promise<{ upToDate: boolean, detailedReason?: string }> {
  if (!pkgSnapshot) {
    return {
      upToDate: false,
      detailedReason: `No snapshot found for local dependency "${depName}" in lockfile`,
    }
  }
  const localDepDir = path.join(lockfileDir, (pkgSnapshot.resolution as DirectoryResolution).directory)
  const manifest = await safeReadPackageJsonFromDir(localDepDir)
  if (!manifest) {
    return {
      upToDate: false,
      detailedReason: `Cannot read package manifest for local dependency "${depName}" at "${localDepDir}"`,
    }
  }
  for (const depField of DEPENDENCIES_OR_PEER_FIELDS) {
    if (depField === 'devDependencies') continue
    const manifestDeps = manifest[depField] ?? {}
    const lockfileDeps = pkgSnapshot[depField] ?? {}

    // Lock file has more dependencies than the current manifest, e.g. some dependencies are removed.
    const removedDep = Object.keys(lockfileDeps).find(d => !manifestDeps[d])
    if (removedDep) {
      return {
        upToDate: false,
        detailedReason: `Local dependency "${depName}" removed dependency "${removedDep}" from manifest`,
      }
    }

    for (const d of Object.keys(manifestDeps)) {
      // If a dependency does not exist in the lock file, e.g. a new dependency is added to the current manifest.
      // We need to do full resolution again.
      if (!lockfileDeps[d]) {
        return {
          upToDate: false,
          detailedReason: `Local dependency "${depName}" added dependency "${d}" not recorded in lockfile`,
        }
      }
      const currentSpec = manifestDeps[d]
      // We do not care about the link dependencies of local dependency.
      if (currentSpec.startsWith('file:') || currentSpec.startsWith('link:') || currentSpec.startsWith('workspace:')) continue
      if (!semver.satisfies(lockfileDeps[d], getVersionRange(currentSpec), { loose: true })) {
        return {
          upToDate: false,
          detailedReason: `Local dependency "${depName}" dependency "${d}@${lockfileDeps[d]}" does not satisfy "${currentSpec}"`,
        }
      }
    }
  }
  return { upToDate: true }
}

function getVersionRange (spec: string): string {
  if (spec.startsWith('workspace:')) return spec.slice(10)
  if (spec.startsWith('npm:')) {
    spec = spec.slice(4)
    const index = spec.indexOf('@', 1)
    if (index === -1) return '*'
    return spec.slice(index + 1) || '*'
  }
  return spec
}
