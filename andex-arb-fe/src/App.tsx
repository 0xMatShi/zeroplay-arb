import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Landing } from './pages/Landing'
import { DashboardPage } from './pages/DashboardPage'
import { Scanner } from './pages/Scanner'
import { Calculator } from './pages/Calculator'
import { Pricing } from './pages/Pricing'
import { DesktopRecommendedBanner } from './components/DesktopRecommendedBanner'
import './App.css'

const queryClient = new QueryClient()

function AuthGuard() {
  useEffect(() => {
    const handler = () => {
      queryClient.clear()
      window.location.href = '/'
    }
    window.addEventListener('auth:unauthorized', handler)
    return () => window.removeEventListener('auth:unauthorized', handler)
  }, [])
  return null
}

function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [pathname])

  return null
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGuard />
        <ScrollToTop />
        <DesktopRecommendedBanner />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/scanner" element={<Scanner />} />
          <Route path="/calculator" element={<Calculator />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
