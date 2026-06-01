import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../../stores/auth'
import { useT } from '../../i18n'

export default function CallbackPage() {
  const t = useT()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const setUserFromToken = useAuthStore(s => s.setUserFromToken)
  const [error, setError] = useState('')

  useEffect(() => {
    const accessToken = searchParams.get('accessToken')
    const verifiedToken = searchParams.get('verifiedToken')
    const email = searchParams.get('email')
    const err = searchParams.get('error')

    if (err) {
      setError(err === 'expired_token' ? t('auth.linkExpired') : err === 'suspended' ? t('auth.accountSuspended') : t('auth.somethingWentWrong'))
      return
    }

    if (accessToken) {
      // Existing user — logged in via magic link
      setUserFromToken(accessToken).then(() => navigate('/'))
    } else if (verifiedToken && email) {
      // New user — redirect to auth page with registration step
      navigate(`/auth?step=username&verifiedToken=${verifiedToken}&email=${encodeURIComponent(email)}`)
    } else {
      setError(t('auth.invalidCallback'))
    }
  }, [searchParams, navigate, setUserFromToken])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <div className="text-center">
          <p className="text-[var(--color-red)] text-[15px] mb-4">{error}</p>
          <a href="/auth" className="text-[var(--color-blue)] text-[14px] hover:underline">{t('auth.backToSignIn')}</a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <p className="text-[var(--color-gray-3)] text-[14px]">{t('auth.signingIn')}</p>
    </div>
  )
}
