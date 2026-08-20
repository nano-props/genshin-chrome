import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'nano.genshinchrome',
  productName: 'Genshin Chrome',
  icon: 'resources/app-icon.png',
  directories: {
    output: 'release',
  },
  files: [
    'dist/**/*',
    'resources/**/*',
    'src/browser-types.ts',
    'src/config-editor-preload.ts',
    'src/config-editor-types.ts',
    'src/config-editor.ts',
    'src/config-types.ts',
    'src/keyboard-shortcuts.ts',
    'src/local-config.ts',
    'src/main.ts',
    'src/preload.ts',
    'src/recent-pages.ts',
    'src/window-state.ts',
    'package.json',
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'dir', arch: ['arm64', 'x64'] },
    ],
    identity: '-',
    hardenedRuntime: false,
    artifactName: '${productName}-${version}-${arch}.${ext}',
  },
}

export default config
