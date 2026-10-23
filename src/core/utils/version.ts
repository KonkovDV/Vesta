/**
 * Compare two semantic version strings to determine whether the first is newer.
 */
export function isNewerVersion(
  version1: string,
  version2: string,
  includePreReleases = false,
): boolean {
  const normalize = (value: string): string => value.replace(/^v/, '');
  const [base1, pre1] = normalize(version1).split('-');
  const [base2, pre2] = normalize(version2).split('-');

  if (!includePreReleases && pre1) {
    return false;
  }

  const version1Parts = base1.split('.').map((part) => parseInt(part, 10) || 0);
  const version2Parts = base2.split('.').map((part) => parseInt(part, 10) || 0);
  const maxLength = Math.max(version1Parts.length, version2Parts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = version1Parts[index] || 0;
    const right = version2Parts[index] || 0;

    if (left > right) {
      return true;
    }

    if (left < right) {
      return false;
    }
  }

  if (!pre1 && pre2) {
    return true;
  }

  if (pre1 && !pre2) {
    return false;
  }

  if (!pre1 && !pre2) {
    return false;
  }

  const pre1Number = parseInt(pre1.split('.')[1], 10) || 0;
  const pre2Number = parseInt(pre2.split('.')[1], 10) || 0;
  return pre1Number > pre2Number;
}

/**
 * Parse the major version number from a tag string.
 */
export function parseMajorVersion(tag: string): number {
  const normalized = tag.replace(/^v/, '');
  const major = parseInt(normalized.split('.')[0], 10);
  return Number.isNaN(major) ? 0 : major;
}