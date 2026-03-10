import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { config } from './config/wagmi'
import { Landing } from './pages/Landing'
import { Dashboard } from './pages/Dashboard'
import { Scanner } from './pages/Scanner'
import { Calculator } from './pages/Calculator'
import { AppLayout } from './components/AppLayout'
import './App.css'

const queryClient = new QueryClient()

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route element={<AppLayout />}>
              <Route path="/dashboard" element={<Dashboard />} />
            </Route>
            <Route path="/scanner" element={<Scanner />} />
            <Route path="/calculator" element={<Calculator />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
