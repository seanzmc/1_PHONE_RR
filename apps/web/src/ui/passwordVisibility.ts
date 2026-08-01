export function passwordVisibilityLabel(label: string, visible: boolean): string {
  return `${visible ? 'Hide' : 'Show'} ${label}`
}
