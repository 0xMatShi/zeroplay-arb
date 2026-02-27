import { useEffect } from 'react'

interface ToastProps {
  message: string
  type?: 'error' | 'success'
  onClose: () => void
  duration?: number
}

export function Toast({ message, type = 'error', onClose, duration = 5000 }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose()
    }, duration)

    return () => clearTimeout(timer)
  }, [onClose, duration])

  return (
    <div className={`toast toast-${type}`}>
      <span className="toast-icon">{type === 'error' ? '✕' : '✓'}</span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" onClick={onClose}>×</button>
    </div>
  )
}
