export function managerPasswordLabels(displayName: string) {
  return {
    initial: 'Initial password',
    manualReset: `Temporary password for ${displayName}`,
  }
}
