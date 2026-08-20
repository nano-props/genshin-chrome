type KeyboardInput = {
  type: string
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  isAutoRepeat: boolean
  isComposing: boolean
}

export function commandShortcutKey(input: KeyboardInput) {
  const commandKey = process.platform === 'darwin' ? input.meta : input.control
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || input.shift || input.alt || !commandKey) {
    return null
  }
  return input.key.toLowerCase()
}
