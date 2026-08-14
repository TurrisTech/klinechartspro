import { login } from './auth'

// Plain imperative DOM, matching the rest of client/ (no framework here — ChartPro.svelte
// is the only Svelte component this app mounts, and only after login succeeds).

export function renderLogin(container: HTMLElement, onSuccess: () => void): void {
  container.innerHTML = ''

  const form = document.createElement('form')
  form.className = 'wd-login'

  const heading = document.createElement('h1')
  heading.className = 'wd-login-heading'
  heading.textContent = 'Sign in'

  const usernameInput = document.createElement('input')
  usernameInput.type = 'text'
  usernameInput.name = 'username'
  usernameInput.placeholder = 'Username'
  usernameInput.autocomplete = 'username'
  usernameInput.required = true
  usernameInput.className = 'wd-login-input'

  const passwordInput = document.createElement('input')
  passwordInput.type = 'password'
  passwordInput.name = 'password'
  passwordInput.placeholder = 'Password'
  passwordInput.autocomplete = 'current-password'
  passwordInput.required = true
  passwordInput.className = 'wd-login-input'

  const error = document.createElement('p')
  error.className = 'wd-login-error'
  error.hidden = true

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'wd-login-submit'
  submit.textContent = 'Sign in'

  form.append(heading, usernameInput, passwordInput, error, submit)
  container.appendChild(form)
  usernameInput.focus()

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    error.hidden = true
    submit.disabled = true
    submit.textContent = 'Signing in…'

    login(usernameInput.value, passwordInput.value)
      .then(onSuccess)
      .catch((err: unknown) => {
        // Invalid credentials and a network/server failure both land here; either way the
        // form must not silently do nothing.
        error.textContent = err instanceof Error ? err.message : 'Sign in failed'
        error.hidden = false
        submit.disabled = false
        submit.textContent = 'Sign in'
        passwordInput.value = ''
        passwordInput.focus()
      })
  })
}
