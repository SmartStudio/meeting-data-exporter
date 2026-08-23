import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/base.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 节点不存在，无法挂载应用')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
