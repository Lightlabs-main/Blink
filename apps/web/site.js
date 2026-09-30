// Blink-to-Stock website: dateline, ticker and live drops from the Blink API (same origin, /api). Real data only.
;(function () {
  const LABEL = { GIFT: 'Gift', TAP_RUSH: 'Tap Rush', EARLY_CLAIM: 'Early Claim', REFERRAL: 'Referral', SEEKER: 'Seeker Drop' }

  const today = document.getElementById('today')
  if (today) {
    today.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  }

  function el(tag, props, children) {
    const node = document.createElement(tag)
    Object.assign(node, props || {})
    for (const c of children || []) node.append(c)
    return node
  }

  // Display only: raw base units → shares, using the stock's current multiplier.
  function shares(raw, asset) {
    if (!asset) return null
    const n = (Number(raw) / Math.pow(10, asset.decimals)) * (asset.multiplier == null ? 1 : asset.multiplier)
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
  }

  const ticker = document.getElementById('ticker')
  function loopTicker() {
    // Two copies so the strip scrolls seamlessly (the animation moves it by half its width).
    if (ticker && !ticker.dataset.looped) {
      ticker.dataset.looped = '1'
      for (const item of [...ticker.children]) ticker.append(item.cloneNode(true))
    }
  }

  const rows = document.getElementById('drop-rows')
  const sideTitle = document.getElementById('side-drops')
  const sideNote = document.getElementById('side-drops-note')

  function noDrops(message) {
    if (rows) rows.replaceChildren(el('tr', { className: 'empty-row' }, [el('td', { colSpan: 5, textContent: message })]))
    if (sideTitle) sideTitle.textContent = 'No live drops'
    if (sideNote) sideNote.textContent = 'New drops are listed the moment a creator funds one. Got a QR from a friend? Scan it in the app.'
  }

  Promise.all([fetch('/api/v1/campaigns'), fetch('/api/v1/xstocks')])
    .then(async ([c, x]) => {
      if (!c.ok) throw new Error('unavailable')
      const campaigns = ((await c.json()).campaigns || []).filter((d) => d.rewardPerClaimRaw)
      const assets = x.ok ? (await x.json()).xstocks : []

      if (ticker) {
        ticker.prepend(el('span', { className: 'ticker-item' }, [el('b', { textContent: 'LIVE' }), campaigns.length + (campaigns.length === 1 ? ' drop open now' : ' drops open now')]))
      }
      loopTicker()

      if (!campaigns.length) return noDrops('No live drops right now — check back soon, or scan a friend’s QR in the app.')

      if (sideTitle) sideTitle.textContent = campaigns.length + (campaigns.length === 1 ? ' live drop' : ' live drops')
      if (sideNote) sideNote.textContent = 'Open for claiming right now. See Section B for the full listing.'

      rows.replaceChildren(
        ...campaigns.slice(0, 20).map((d) => {
          const asset = assets.find((a) => a.mint === d.mint)
          const reward = BigInt(d.rewardPerClaimRaw)
          const total = BigInt(d.allowanceRaw) / reward
          const taken = BigInt(d.claimedRaw) / reward
          const pct = total > 0n ? Number((taken * 100n) / total) : 0
          const row = el('tr', { tabIndex: 0 }, [
            el('td', {}, [el('span', { className: 'sym', textContent: d.xstockSymbol })]),
            el('td', { textContent: LABEL[d.type] || 'Drop' }),
            el('td', { className: 'num', textContent: shares(d.rewardPerClaimRaw, asset) || '—' }),
            el('td', {}, [
              el('span', { className: 'bar' }, [el('span', { style: 'width:' + Math.min(100, pct) + '%' })]),
              ' ' + taken + '/' + total,
            ]),
            el('td', {}, [el('span', { className: 'status live', textContent: 'Open' })]),
          ])
          row.dataset.href = '/c/' + d.id
          const go = () => (location.href = row.dataset.href)
          row.addEventListener('click', go)
          row.addEventListener('keydown', (e) => e.key === 'Enter' && go())
          return row
        }),
      )
    })
    .catch(() => {
      loopTicker()
      noDrops('Listings are unavailable right now. Please try again shortly.')
    })
})()
