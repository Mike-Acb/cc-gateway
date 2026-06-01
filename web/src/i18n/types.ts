export type Locale = 'zh' | 'en'

export type TranslationKeys = {
  // Common
  'common.loading': string
  'common.save': string
  'common.cancel': string
  'common.confirm': string
  'common.delete': string
  'common.edit': string
  'common.create': string
  'common.search': string
  'common.optional': string
  'common.required': string
  'common.back': string
  'common.next': string
  'common.submit': string
  'common.retry': string
  'common.close': string
  'common.copy': string
  'common.copied': string
  'common.enabled': string
  'common.disabled': string
  'common.active': string
  'common.inactive': string
  'common.status': string
  'common.actions': string
  'common.name': string
  'common.type': string
  'common.date': string
  'common.amount': string
  'common.total': string
  'common.none': string
  'common.yes': string
  'common.no': string
  'common.error': string
  'common.success': string

  // Auth
  'auth.signIn': string
  'auth.signInDesc': string
  'auth.email': string
  'auth.emailPlaceholder': string
  'auth.continueWithEmail': string
  'auth.sending': string
  'auth.checkInbox': string
  'auth.codeSentTo': string
  'auth.waitingVerification': string
  'auth.clickLinkOrWait': string
  'auth.enterCodeManually': string
  'auth.verificationCode': string
  'auth.verify': string
  'auth.verifying': string
  'auth.changeEmail': string
  'auth.resendCode': string
  'auth.resendIn': string
  'auth.welcomeAboard': string
  'auth.chooseUsername': string
  'auth.username': string
  'auth.usernamePlaceholder': string
  'auth.inviteCode': string
  'auth.inviteCodePlaceholder': string
  'auth.inviteCodeHint': string
  'auth.createAccount': string
  'auth.creatingAccount': string
  'auth.enterEmail': string
  'auth.enter6DigitCode': string
  'auth.chooseAUsername': string
  'auth.signingIn': string
  'auth.invalidCallback': string
  'auth.linkExpired': string
  'auth.accountSuspended': string
  'auth.somethingWentWrong': string
  'auth.backToSignIn': string

  // Branding
  'brand.name': string
  'brand.tagline': string
  'brand.heroTitle': string
  'brand.heroHighlight': string
  'brand.heroDesc': string
  'brand.featureUsage': string
  'brand.featureUsageDesc': string
  'brand.featureMultiDevice': string
  'brand.featureMultiDeviceDesc': string
  'brand.featureBilling': string
  'brand.featureBillingDesc': string
  'brand.poweredBy': string

  // Nav / Sidebar
  'nav.dashboard': string
  'nav.usage': string
  'nav.clients': string
  'nav.plans': string
  'nav.billing': string
  'nav.invite': string
  'nav.rewards': string
  'nav.webhooks': string
  'nav.settings': string
  'nav.admin': string
  'nav.adminUsers': string
  'nav.adminClients': string
  'nav.adminQuotas': string
  'nav.adminCosts': string
  'nav.adminPricing': string
  'nav.adminCampaigns': string
  'nav.adminSystem': string
  'nav.adminPlans': string
  'nav.adminAccounts': string
  'nav.adminProxies': string
  'nav.adminFingerprints': string
  'nav.logout': string
  'nav.sectionDashboard': string
  'nav.sectionManage': string
  'nav.sectionFinance': string
  'nav.sectionSocial': string
  'nav.sectionSystem': string
  'nav.sectionAdmin': string

  // Dashboard
  'dashboard.title': string
  'dashboard.totalRequests': string
  'dashboard.totalCost': string
  'dashboard.totalTokens': string
  'dashboard.avgLatency': string

  // Clients
  'clients.title': string
  'clients.apiKey': string
  'clients.createClient': string
  'clients.noClients': string

  // Usage
  'usage.title': string
  'usage.period': string
  'usage.model': string
  'usage.requests': string
  'usage.tokens': string
  'usage.cost': string
  'usage.latency': string

  // Plans
  'plans.title': string
  'plans.currentPlan': string
  'plans.subscribe': string
  'plans.balance': string

  // Billing
  'billing.title': string
  'billing.invoices': string
  'billing.payments': string

  // Invite
  'invite.title': string
  'invite.yourCode': string
  'invite.invited': string
  'invite.getCode': string

  // Rewards
  'rewards.title': string
  'rewards.noRewards': string

  // Settings
  'settings.title': string
  'settings.profile': string
  'settings.language': string

  // Webhooks
  'webhooks.title': string
  'webhooks.createWebhook': string
  'webhooks.noWebhooks': string
}

export type Translations = Record<Locale, TranslationKeys>
