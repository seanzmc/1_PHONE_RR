import { vi } from 'vitest'

export function createLifecycleContainer(activeElement: HTMLElement | null): {
  container: Element
  document: { activeElement: HTMLElement | null }
  cleanup: () => void
} {
  const documentStub = {
    nodeType: 9,
    activeElement,
    defaultView: globalThis,
    addEventListener() {},
    removeEventListener() {},
    documentElement: null as unknown,
  }
  const container = {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
  }
  documentStub.documentElement = container
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('HTMLIFrameElement', class {})
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return {
    container: container as unknown as Element,
    document: documentStub,
    cleanup: () => vi.unstubAllGlobals(),
  }
}
