import AppRouter from './router'
import { I18nProvider } from './i18n'
import { DialogHost } from './ui'

export default function App() {
  return (
    <I18nProvider>
      <AppRouter />
      <DialogHost />
    </I18nProvider>
  )
}
