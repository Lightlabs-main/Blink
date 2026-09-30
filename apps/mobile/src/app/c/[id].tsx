import { Redirect, useLocalSearchParams } from 'expo-router'

import { REFERRAL_CODE_RE } from '../../shared'

/** https://blinksol.site/c/<id>[?ref=CODE] App Links land here; forward to the campaign screen. */
export default function CampaignLink() {
  const { id, ref } = useLocalSearchParams<{ id: string; ref?: string }>()
  const valid = typeof ref === 'string' && REFERRAL_CODE_RE.test(ref)
  return <Redirect href={{ pathname: '/campaign/[id]', params: valid ? { id: String(id), ref } : { id: String(id) } }} />
}
