import { readonly, ref } from 'vue'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'lindu-theme'

const getInitialTheme = (): ThemeMode => {
  try {
    const storedTheme = localStorage.getItem(STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
  } catch {
    // A blocked storage area should not prevent the renderer from starting.
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const theme = ref<ThemeMode>(getInitialTheme())

const applyTheme = (mode: ThemeMode): void => {
  document.documentElement.classList.toggle('dark', mode === 'dark')
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode
}

export const initializeTheme = (): void => applyTheme(theme.value)

export const useTheme = () => {
  const setTheme = (mode: ThemeMode): void => {
    theme.value = mode
    applyTheme(mode)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // Theme still applies for this session when persistence is unavailable.
    }
  }

  const toggleTheme = (): void => setTheme(theme.value === 'light' ? 'dark' : 'light')

  return {
    theme: readonly(theme),
    setTheme,
    toggleTheme,
  }
}
