import PetCanvas from './pet/PetCanvas'
import { PET_WINDOW_TITLE, PLACEHOLDER_NOTE } from '../../shared/pet-config'

function App(): React.JSX.Element {
  const electronVersion = window.yaoyao?.electronVersion ?? '未知'

  return (
    <main className="app">
      <h1 className="app__title">{PET_WINDOW_TITLE}</h1>
      <PetCanvas />
      <p className="app__note">{PLACEHOLDER_NOTE}</p>
      <p className="app__meta">Electron {electronVersion}</p>
    </main>
  )
}

export default App
