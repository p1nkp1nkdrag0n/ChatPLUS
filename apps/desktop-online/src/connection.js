const form = document.getElementById("connection");
const origin = document.getElementById("origin");
const button = document.getElementById("connect");
const error = document.getElementById("error");
window.dearvaleConnection.state().then((state) => { origin.value = state.origin; error.textContent = state.error; }).catch(() => { error.textContent = "连接界面暂时不可用，请重启应用。"; });
form.addEventListener("submit", async (event) => {
  event.preventDefault(); button.disabled = true; button.textContent = "正在连接…"; error.textContent = "";
  try { const result = await window.dearvaleConnection.connect(origin.value); if (!result.ok) error.textContent = result.error; }
  catch { error.textContent = "连接中断，请重试。"; }
  finally { button.disabled = false; button.textContent = "连接 Dearvale"; }
});
