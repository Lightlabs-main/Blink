// Light / dark switch. The choice is remembered per browser; without one, the system setting decides.
;(function () {
  const root = document.documentElement
  const dark = () => root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)

  function render() {
    for (const label of document.querySelectorAll('[data-theme-label]')) label.textContent = dark() ? 'Light' : 'Dark'
  }

  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      const next = dark() ? 'light' : 'dark'
      root.dataset.theme = next
      try {
        localStorage.setItem('blink-theme', next)
      } catch (e) {}
      render()
    })
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render)
  render()
})()
