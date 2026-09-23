// Shared frontend auth helper for Moyo pages.
// Include this before any code that calls the API: <script src="/auth-client.js"></script>
//
// Next session: wire index.html's existing fetch() calls to use moyoFetch() below
// instead of bare fetch(), so every API call carries the Authorization header.

function moyoRequireAuth() {
  const token = localStorage.getItem('moyo_token');
  if (!token) {
    window.location.href = '/login.html';
    return null;
  }
  return token;
}

async function moyoFetch(url, options = {}) {
  const token = localStorage.getItem('moyo_token');
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    localStorage.removeItem('moyo_token');
    localStorage.removeItem('moyo_user_email');
    window.location.href = '/login.html';
    return null;
  }
  return response;
}

function moyoLogout() {
  localStorage.removeItem('moyo_token');
  localStorage.removeItem('moyo_user_email');
  window.location.href = '/login.html';
}
