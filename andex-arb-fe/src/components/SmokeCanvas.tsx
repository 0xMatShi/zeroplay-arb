import { useEffect, useRef } from 'react'

interface Puff {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  opacity: number
  opacityDir: number
  maxOpacity: number
  colorT: number
  colorSpeed: number
  wobblePhase: number
  wobbleSpeed: number
}

// Lerp between brand colors: #3ED6FF (cyan) → #F472B6 (pink)
function brandColor(t: number, opacity: number): string {
  const r = Math.round(62 + (244 - 62) * t)
  const g = Math.round(214 + (114 - 214) * t)
  const b = Math.round(255 + (182 - 255) * t)
  return `rgba(${r},${g},${b},${opacity})`
}

function spawnPuff(w: number, h: number, scattered = false): Puff {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.133,
    vy: (Math.random() - 0.5) * 0.133,
    radius: 130 + Math.random() * 220,
    opacity: scattered ? Math.random() * 0.1 : 0,
    opacityDir: Math.random() * 0.00067 + 0.00033,
    maxOpacity: 0.08 + Math.random() * 0.05,
    colorT: Math.random(),
    colorSpeed: (Math.random() - 0.5) * 0.00067,
    wobblePhase: Math.random() * Math.PI * 2,
    wobbleSpeed: (Math.random() - 0.5) * 0.002,
  }
}

export function SmokeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    const PUFF_COUNT = 45

    function resize() {
      canvas!.width = canvas!.offsetWidth
      canvas!.height = canvas!.offsetHeight
    }

    resize()

    // Init: scatter across entire screen already visible
    const puffs: Puff[] = Array.from({ length: PUFF_COUNT }, () =>
      spawnPuff(canvas.width, canvas.height, true),
    )

    function frame() {
      const w = canvas!.width
      const h = canvas!.height
      ctx!.clearRect(0, 0, w, h)

      for (const p of puffs) {
        // Drift with gentle wobble
        p.x += p.vx + Math.sin(p.wobblePhase) * 0.1
        p.y += p.vy + Math.cos(p.wobblePhase * 0.7) * 0.067
        p.wobblePhase += p.wobbleSpeed
        p.colorT = ((p.colorT + p.colorSpeed) % 1 + 1) % 1

        // Wrap around screen edges (seamless)
        if (p.x > w + p.radius) p.x = -p.radius
        else if (p.x < -p.radius) p.x = w + p.radius
        if (p.y > h + p.radius) p.y = -p.radius
        else if (p.y < -p.radius) p.y = h + p.radius

        // Opacity pulse: breathe in and out
        p.opacity += p.opacityDir
        if (p.opacity >= p.maxOpacity) {
          p.opacityDir = -Math.abs(p.opacityDir)
        } else if (p.opacity <= 0) {
          // Teleport to new random position when fully faded
          Object.assign(p, spawnPuff(w, h, false))
          continue
        }

        const op = Math.max(0, p.opacity)

        const grad = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius)
        grad.addColorStop(0, brandColor(p.colorT, op))
        grad.addColorStop(0.45, brandColor((p.colorT + 0.2) % 1, op * 0.5))
        grad.addColorStop(1, brandColor((p.colorT + 0.4) % 1, 0))

        ctx!.beginPath()
        ctx!.fillStyle = grad
        ctx!.arc(p.x, p.y, p.radius, 0, Math.PI * 2)
        ctx!.fill()
      }

      animId = requestAnimationFrame(frame)
    }

    frame()

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    return () => {
      cancelAnimationFrame(animId)
      ro.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )
}
