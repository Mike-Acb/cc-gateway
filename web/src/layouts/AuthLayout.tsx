import { Outlet } from 'react-router-dom'

export default function AuthLayout() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] flex items-center justify-center">
      <Outlet />
    </div>
  )
}
