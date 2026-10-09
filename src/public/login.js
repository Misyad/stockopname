const form = document.querySelector('#login-form');
const button = document.querySelector('#login-button');
const output = document.querySelector('#login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  output.hidden = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || 'Login gagal.');
    location.replace('/masters/products');
  } catch (error) {
    output.textContent = error instanceof TypeError
      ? 'Tidak dapat terhubung. Coba lagi.'
      : error.message;
    output.hidden = false;
  } finally {
    button.disabled = false;
  }
});
