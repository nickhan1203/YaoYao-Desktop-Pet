import PetCanvas from './pet/PetCanvas'
import { PLACEHOLDER_NOTE } from '../../shared/pet-config'

function App(): React.JSX.Element {
  return (
    <main className="app" aria-label={PLACEHOLDER_NOTE}>
      <PetCanvas />
      <span className="app__label">幺幺</span>
    </main>
  )
}

export default App
