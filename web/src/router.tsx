import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './stores/auth'

import AppShell from './layouts/AppShell'
import AuthPage from './pages/auth/AuthPage'
import CallbackPage from './pages/auth/CallbackPage'
import DevKitPreview from './pages/dev/DevKitPreview'
import DashboardPage from './pages/dashboard/DashboardPage'
import UsagePage from './pages/usage/UsagePage'
import LogsPage from './pages/logs/LogsPage'
import ClientsPage from './pages/clients/ClientsPage'
import BillingPage from './pages/billing/BillingPage'
import PlansPage from './pages/plans/PlansPage'
import CheckoutPage from './pages/checkout/CheckoutPage'
import CheckoutResultPage from './pages/checkout/CheckoutResultPage'
import SettingsPage from './pages/settings/SettingsPage'
import AdminDashboardPage from './pages/admin/AdminDashboardPage'
import AdminAccountsPage from './pages/admin/AdminAccountsPage'
import AdminOutboundProxiesPage from './pages/admin/AdminOutboundProxiesPage'
import AdminCCDisguisePage from './pages/admin/AdminCCDisguisePage'
import AdminGroupsPage from './pages/admin/AdminGroupsPage'
import AdminUsersPage from './pages/admin/AdminUsersPage'
import AdminPlansPage from './pages/admin/AdminPlansPage'
import AdminCampaignsPage from './pages/admin/AdminCampaignsPage'
import AdminRequestLogsPage from './pages/admin/AdminRequestLogsPage'
import AdminMetricsPage from './pages/admin/AdminMetricsPage'
import AdminAuditLogPage from './pages/admin/AdminAuditLogPage'
import AdminSystemPage from './pages/admin/AdminSystemPage'
import PublicPoolStatusPage from './pages/PublicPoolStatusPage'

function ProtectedRoute() {
  const { user, loading } = useAuthStore()
  if (loading) return <div className="flex items-center justify-center h-screen text-[13px] text-[var(--mute)]">Loading…</div>
  if (!user) return <Navigate to="/auth" replace />
  return <Outlet />
}

function GuestRoute() {
  const { user, loading } = useAuthStore()
  if (loading) return <div className="flex items-center justify-center h-screen text-[13px] text-[var(--mute)]">Loading…</div>
  if (user) return <Navigate to="/" replace />
  return <Outlet />
}

function AdminRoute() {
  const { user } = useAuthStore()
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}

export default function AppRouter() {
  const fetchMe = useAuthStore((s) => s.fetchMe)
  useEffect(() => { fetchMe() }, [fetchMe])

  return (
    <BrowserRouter>
      <Routes>
        {/* Public read-only pool status — no auth required */}
        <Route path="/pool-status" element={<PublicPoolStatusPage />} />

                <Route element={<GuestRoute />}>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/auth/callback" element={<CallbackPage />} />
        </Route>

        {/* Legacy redirects */}
        <Route path="/login" element={<Navigate to="/auth" replace />} />
        <Route path="/register" element={<Navigate to="/auth" replace />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            {/* User pages */}
            <Route path="/" element={<DashboardPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/checkout/:planId" element={<CheckoutPage />} />
            <Route path="/checkout/result" element={<CheckoutResultPage />} />
            <Route path="/settings" element={<SettingsPage />} />

            {/* Dev-only kit preview */}
            <Route path="/dev/kit" element={<DevKitPreview />} />

            {/* Admin pages */}
            <Route element={<AdminRoute />}>
              <Route path="/admin" element={<AdminDashboardPage />} />
              <Route path="/admin/accounts" element={<AdminAccountsPage />} />
              <Route path="/admin/cc-disguise" element={<AdminCCDisguisePage />} />
              <Route path="/admin/groups" element={<AdminGroupsPage />} />
              <Route path="/admin/proxies" element={<AdminOutboundProxiesPage />} />
              <Route path="/admin/users" element={<AdminUsersPage />} />
              <Route path="/admin/plans" element={<AdminPlansPage />} />
              <Route path="/admin/campaigns" element={<AdminCampaignsPage />} />
              <Route path="/admin/logs" element={<AdminRequestLogsPage />} />
              <Route path="/admin/metrics" element={<AdminMetricsPage />} />
              <Route path="/admin/audit" element={<AdminAuditLogPage />} />
              <Route path="/admin/system" element={<AdminSystemPage />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
