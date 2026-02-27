import { Outlet } from 'react-router-dom'
import { Footer } from './Footer'

export function AppLayout() {
  return (
    <div className="app-layout">
      <div className="app-layout-main">
        <Outlet />
      </div>
      <Footer />
    </div>
  )
}
