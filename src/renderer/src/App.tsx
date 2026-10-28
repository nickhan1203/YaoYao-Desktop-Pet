import PetCanvas from './pet/PetCanvas'
import { PET_WINDOW_TITLE } from '../../shared/pet-config'

function App(): React.JSX.Element {
  return (
    <main className="app" aria-label={PET_WINDOW_TITLE}>
      <PetCanvas />
    </main>
  )
}

export default App
