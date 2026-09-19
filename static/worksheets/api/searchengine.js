// 設定画面の検索エンジン選択（v2.2.0: 初期表示とアカウント連携を修正）
document.addEventListener('DOMContentLoaded', async function () {
    const se = document.getElementById('searchengine');
    if (!se) return;
    let v = null;
    if (typeof TC_ACCOUNT !== 'undefined') {
        try {
            if (await TC_ACCOUNT.restoreSession()) v = TC_ACCOUNT.getEngine();
        } catch (e) {}
    }
    if (!v) v = localStorage.getItem('searchengine');
    if (v) se.value = v;
});
document.getElementById('searchEngineForm').addEventListener('submit', function (event) {
    event.preventDefault();
    searchEngineSetting = document.getElementById('searchengine').value;
    localStorage.setItem('searchengine', searchEngineSetting);
    if (typeof TC_ACCOUNT !== 'undefined') {
        try { TC_ACCOUNT.saveEngine(searchEngineSetting); } catch (e) {}
    }
    alert(searchEngineSetting + ' is now your default search engine!')
});
