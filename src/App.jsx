import { useState, useEffect, useCallback } from "react";
import { db } from "./firebase";
import { ref, onValue, set, get } from "firebase/database";

const CATEGORIES = ["Zbroja", "Broń", "Hełm", "Buty", "Rękawice", "Płaszcz", "Torba", "Inne"];
const SPLIT_OPTIONS = [
  { label: "50 / 50", value: "50/50" },
  { label: "100% A", value: "100A" },
  { label: "100% B", value: "100B" },
  { label: "75 / 25", value: "75A" },
  { label: "25 / 75", value: "25A" },
];

function splitShares(amount, split, names) {
  if (split === "50/50") return [amount * 0.5, amount * 0.5];
  if (split === "100A") return [amount, 0];
  if (split === "100B") return [0, amount];
  if (split === "75A") return [amount * 0.75, amount * 0.25];
  if (split === "25A") return [amount * 0.25, amount * 0.75];
  return [amount * 0.5, amount * 0.5];
}

function splitLabel(split, names) {
  if (!split || split === "50/50") return "50% / 50%";
  if (split === "100A") return `100% → ${names[0]}`;
  if (split === "100B") return `100% → ${names[1]}`;
  if (split === "75A") return `75% ${names[0]} / 25% ${names[1]}`;
  if (split === "25A") return `25% ${names[0]} / 75% ${names[1]}`;
  return "50/50";
}

function fmtS(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + "k";
  return Math.round(n).toString();
}

const D = () => new Date().toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const TABS = [
  ["dashboard", "📊 Saldo"],
  ["sell", "💰 Sprzedaż"],
  ["buy", "📦 Zakup"],
  ["bank", "🏦 Bank"],
  ["history", "📜 Historia"],
];

export default function App() {
  const [events, setEvents] = useState([]);
  const [playerNames, setPlayerNames] = useState(["Gracz A", "Gracz B"]);
  const [tab, setTab] = useState("dashboard");
  const [flash, setFlash] = useState(null);
  const [editingName, setEditingName] = useState(null);
  const [tempName, setTempName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [connected, setConnected] = useState(true);

  const [sellForm, setSellForm] = useState({ item: "", category: "Zbroja", amount: "", split: "50/50", note: "" });
  const [buyForm, setBuyForm] = useState({ item: "", category: "Zbroja", amount: "", split: "50/50", note: "" });
  const [bankForm, setBankForm] = useState({ subtype: "external_deposit", player: 0, amount: "", note: "" });
  const [lossForm, setLossForm] = useState({ item: "", amount: "", split: "50/50", note: "" });

  // Listen to Firebase in real-time
  useEffect(() => {
    const eventsRef = ref(db, "bm_events");
    const namesRef = ref(db, "bm_players");

    const unsubEvents = onValue(eventsRef, (snap) => {
      const val = snap.val();
      setEvents(val ? Object.values(val).sort((a, b) => b.id - a.id) : []);
      setLastSync(new Date());
      setLoading(false);
      setConnected(true);
    }, (err) => {
      console.error(err);
      setConnected(false);
      setLoading(false);
    });

    const unsubNames = onValue(namesRef, (snap) => {
      const val = snap.val();
      if (val) setPlayerNames(val);
    });

    return () => {
      unsubEvents();
      unsubNames();
    };
  }, []);

  async function saveEvents(evList) {
    setSaving(true);
    try {
      // Convert array to object keyed by id for Firebase
      const obj = {};
      evList.forEach(e => { obj[e.id] = e; });
      await set(ref(db, "bm_events"), obj);
      setLastSync(new Date());
    } catch (e) {
      console.error(e);
      showFlash("Błąd zapisu! Sprawdź połączenie.", "error");
    }
    setSaving(false);
  }

  async function saveNames(data) {
    try {
      await set(ref(db, "bm_players"), data);
    } catch (e) { console.error(e); }
  }

  function showFlash(msg, type = "success") {
    setFlash({ msg, type });
    setTimeout(() => setFlash(null), 2500);
  }

  function computeBalances(evList, names) {
    const bank = [0, 0];
    for (const ev of evList) {
      if (ev.type === "sell") {
        // zysk ze sprzedaży trafia bezpośrednio do banku
        const shares = splitShares(ev.amount, ev.split, names);
        bank[0] += shares[0]; bank[1] += shares[1];
      } else if (ev.type === "buy") {
        const shares = splitShares(ev.amount, ev.split, names);
        bank[0] -= shares[0]; bank[1] -= shares[1];
      } else if (ev.type === "loss") {
        const shares = splitShares(ev.amount, ev.split, names);
        bank[0] -= shares[0]; bank[1] -= shares[1];
      } else if (ev.type === "withdraw") {
        bank[ev.player] -= ev.amount;
      } else if (ev.type === "external_deposit") {
        bank[ev.player] += ev.amount;
      }
    }
    return { bank };
  }

  const { bank: bankBal } = computeBalances(events, playerNames);
  const totalBank = bankBal[0] + bankBal[1];
  const totalRevenue = events.filter(e => e.type === "sell").reduce((s, e) => s + e.amount, 0);
  const totalBought = events.filter(e => e.type === "buy").reduce((s, e) => s + e.amount, 0);
  const totalLoss = events.filter(e => e.type === "loss").reduce((s, e) => s + e.amount, 0);

  async function addSell() {
    const amt = Math.round(Number(sellForm.amount));
    if (!amt || amt <= 0) return showFlash("Podaj kwotę!", "error");
    if (!sellForm.item.trim()) return showFlash("Podaj przedmiot!", "error");
    const ev = { id: Date.now(), type: "sell", ...sellForm, amount: amt, date: D() };
    const next = [ev, ...events];
    setSellForm(f => ({ ...f, item: "", amount: "", note: "" }));
    await saveEvents(next);
    showFlash("Sprzedaż dodana ✓");
  }

  async function addBuy() {
    const amt = Math.round(Number(buyForm.amount));
    if (!amt || amt <= 0) return showFlash("Podaj kwotę!", "error");
    if (!buyForm.item.trim()) return showFlash("Podaj przedmiot!", "error");
    const shares = splitShares(amt, buyForm.split, playerNames);
    for (let i = 0; i < 2; i++) {
      if (shares[i] > 0 && bankBal[i] < shares[i]) {
        return showFlash(`${playerNames[i]} nie ma wystarczająco srebra! (brakuje ${fmtS(shares[i] - bankBal[i])})`, "error");
      }
    }
    const ev = { id: Date.now(), type: "buy", ...buyForm, amount: amt, date: D() };
    const next = [ev, ...events];
    setBuyForm(f => ({ ...f, item: "", amount: "", note: "" }));
    await saveEvents(next);
    showFlash("Zakup zapisany ✓");
  }

  async function addLoss() {
    const amt = Math.round(Number(lossForm.amount));
    if (!amt || amt <= 0) return showFlash("Podaj kwotę straty!", "error");
    const shares = splitShares(amt, lossForm.split, playerNames);
    for (let i = 0; i < 2; i++) {
      if (shares[i] > 0 && bankBal[i] < shares[i]) {
        return showFlash(`${playerNames[i]} nie ma wystarczająco srebra! (brakuje ${fmtS(shares[i] - bankBal[i])})`, "error");
      }
    }
    const ev = { id: Date.now(), type: "loss", ...lossForm, amount: amt, date: D() };
    const next = [ev, ...events];
    setLossForm({ item: "", amount: "", split: "50/50", note: "" });
    await saveEvents(next);
    showFlash("Strata zapisana ✓");
  }

  async function addBankAction() {
    const amt = Math.round(Number(bankForm.amount));
    if (!amt || amt <= 0) return showFlash("Podaj kwotę!", "error");
    const pi = bankForm.player;
    if (bankForm.subtype === "external_deposit") {
      // brak limitu – wpłata z zewnątrz
    } else if (bankForm.subtype === "withdraw") {
      if (bankBal[pi] < amt) return showFlash(`${playerNames[pi]} ma tylko ${fmtS(bankBal[pi])} w banku!`, "error");
    }
    const ev = { id: Date.now(), type: bankForm.subtype, player: pi, amount: amt, note: bankForm.note, date: D() };
    const next = [ev, ...events];
    setBankForm(f => ({ ...f, amount: "", note: "" }));
    await saveEvents(next);
    const msgs = {
      external_deposit: "Wpłacono z zewnątrz do banku ✓",
      withdraw: "Wypłacono z banku ✓",
    };
    showFlash(msgs[bankForm.subtype] || "Zapisano ✓");
  }

  async function deleteEvent(id) {
    const next = events.filter(e => e.id !== id);
    await saveEvents(next);
  }

  async function clearAll() {
    if (!window.confirm("Usunąć WSZYSTKIE dane? Tego nie można cofnąć.")) return;
    await saveEvents([]);
  }

  async function saveName(i, name) {
    const next = [...playerNames];
    next[i] = name || playerNames[i];
    setPlayerNames(next);
    setEditingName(null);
    await saveNames(next);
  }

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#0d0f14", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif", color: "#c9a84c" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>⚔️</div>
        <div style={{ fontSize: 12, letterSpacing: 3 }}>ŁADOWANIE...</div>
        <div style={{ fontSize: 10, color: "#3a2a1a", marginTop: 6 }}>łączenie z bazą danych...</div>
      </div>
    </div>
  );

  const icons = ["🗡️", "🛡️"];

  function SplitPicker({ value, onChange }) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 5 }}>
        {SPLIT_OPTIONS.map(s => (
          <button key={s.value} onClick={() => onChange(s.value)} style={{
            padding: "8px 2px", borderRadius: 7, fontSize: 9, letterSpacing: 0.3,
            background: value === s.value ? "#1f1a08" : "#0d0f14",
            border: `1px solid ${value === s.value ? "#c9a84c99" : "#c9a84c1a"}`,
            color: value === s.value ? "#c9a84c" : "#6a5a3a",
            cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s"
          }}>{s.label}</button>
        ))}
      </div>
    );
  }

  function SplitPreview({ amount, split }) {
    const amt = Math.round(Number(amount));
    if (!amt || amt <= 0) return null;
    const shares = splitShares(amt, split, playerNames);
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8, background: "#0d0f14", border: "1px solid #c9a84c1a", borderRadius: 8, padding: "8px 12px" }}>
        {playerNames.map((name, i) => (
          <div key={i} style={{ textAlign: "center" }}>
            <p style={{ fontSize: 9, color: "#6a5a3a", marginBottom: 2 }}>{icons[i]} {name}</p>
            <p style={{ fontSize: 15, color: "#8adc8a", fontWeight: 700 }}>{fmtS(shares[i])}</p>
          </div>
        ))}
      </div>
    );
  }

  function BuySplitPreview({ amount, split }) {
    const amt = Math.round(Number(amount));
    if (!amt || amt <= 0) return null;
    const shares = splitShares(amt, split, playerNames);
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8, background: "#0d0f14", border: "1px solid #c9a84c1a", borderRadius: 8, padding: "8px 12px" }}>
        {playerNames.map((name, i) => {
          const canAfford = bankBal[i] >= shares[i];
          return (
            <div key={i} style={{ textAlign: "center" }}>
              <p style={{ fontSize: 9, color: "#6a5a3a", marginBottom: 2 }}>{icons[i]} {name}</p>
              <p style={{ fontSize: 15, fontWeight: 700, color: shares[i] === 0 ? "#4a4a4a" : canAfford ? "#ff8a8a" : "#ff4444" }}>{fmtS(shares[i])}</p>
              {shares[i] > 0 && <p style={{ fontSize: 9, color: canAfford ? "#4a8a4a" : "#8a2222", marginTop: 1 }}>{canAfford ? `✓ stać (${fmtS(bankBal[i])})` : `✗ brakuje ${fmtS(shares[i] - bankBal[i])}`}</p>}
            </div>
          );
        })}
      </div>
    );
  }

  function inputStyle(borderColor = "#c9a84c33") {
    return { width: "100%", background: "#0d0f14", border: `1px solid ${borderColor}`, borderRadius: 8, padding: "10px 12px", color: "#e8dcc8", fontSize: 13, fontFamily: "Georgia, serif", outline: "none" };
  }
  function labelStyle() {
    return { fontSize: 10, color: "#6a5a3a", letterSpacing: 1, display: "block", marginBottom: 6 };
  }

  const typeColors = { sell: "#8adc8a", buy: "#ff8a8a", loss: "#ff6644", withdraw: "#c9a84c", external_deposit: "#a06aff" };
  const typeLabels = { sell: "💰 SPRZEDAŻ", buy: "📦 ZAKUP", loss: "💀 STRATA", withdraw: "⬇ WYPŁATA", external_deposit: "🪄 WPŁATA Z ZEWNĄTRZ" };

  return (
    <div style={{ minHeight: "100vh", background: "#0d0f14", color: "#e8dcc8", fontFamily: "'Cinzel', Georgia, serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Pro:wght@300;400&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:#0d0f14}::-webkit-scrollbar-thumb{background:#c9a84c44;border-radius:3px}
        .tab-btn{background:none;border:none;cursor:pointer;font-family:inherit}
        .del-btn{background:none;border:none;cursor:pointer;color:#ff6b6b22;font-size:12px;padding:4px;transition:color 0.2s;flex-shrink:0}
        .del-btn:hover{color:#ff6b6b}
        .tx-row:hover{background:#ffffff04!important}
        .action-btn{transition:all 0.2s;border:none;cursor:pointer;font-family:inherit;font-weight:700;letter-spacing:1.5px;border-radius:10px;padding:13px;font-size:11px;width:100%}
        .action-btn:hover{transform:translateY(-1px)}
        .action-btn:disabled{opacity:0.5;cursor:wait;transform:none}
        @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        .fade-in{animation:fadeIn 0.25s ease}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        .sub-tab{transition:all 0.15s;background:none;border:none;cursor:pointer;font-family:inherit}
      `}</style>

      {/* HEADER */}
      <div style={{ background: "linear-gradient(180deg,#1a1408,#0d0f14)", borderBottom: "1px solid #c9a84c2a", padding: "16px 16px 0" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ fontSize: 20 }}>⚔️</span>
              <h1 style={{ fontSize: 15, fontWeight: 700, color: "#c9a84c", letterSpacing: 2 }}>BLACK MARKET TRACKER</h1>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {saving && <div style={{ width: 10, height: 10, border: "2px solid #c9a84c22", borderTop: "2px solid #c9a84c", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />}
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "#4adc4a" : "#dc4a4a", boxShadow: connected ? "0 0 6px #4adc4a" : "0 0 6px #dc4a4a" }} title={connected ? "Połączono" : "Brak połączenia"} />
            </div>
          </div>
          <p style={{ fontSize: 9, color: "#3a2a1a", letterSpacing: 1, marginBottom: 12, fontFamily: "Georgia, serif", fontStyle: "italic" }}>
            Synchronizacja Firebase · {lastSync ? `ostatnia: ${lastSync.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "łączenie..."}
          </p>
          <div style={{ display: "flex", gap: 0, overflowX: "auto" }}>
            {TABS.map(([key, label]) => (
              <button key={key} className="tab-btn" onClick={() => setTab(key)} style={{ padding: "7px 11px", fontSize: 9, letterSpacing: 1, color: tab === key ? "#c9a84c" : "#6a5a3a", borderBottom: tab === key ? "2px solid #c9a84c" : "2px solid transparent", whiteSpace: "nowrap", fontFamily: "inherit" }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      {flash && <div style={{ position: "fixed", top: 18, right: 16, zIndex: 999, background: flash.type === "success" ? "#162416" : "#2a1010", border: `1px solid ${flash.type === "success" ? "#3a6a3a" : "#6a2a2a"}`, color: flash.type === "success" ? "#8adc8a" : "#dc8a8a", padding: "9px 16px", borderRadius: 8, fontSize: 12, fontFamily: "Georgia, serif", maxWidth: 280 }}>{flash.msg}</div>}

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "18px 12px 40px" }}>

        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <div className="fade-in">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
              {[
                { label: "Przychód BM", val: totalRevenue, col: "#8adc8a", icon: "💰" },
                { label: "Wydatki", val: totalBought, col: "#ff8a8a", icon: "📦" },
                { label: "Straty", val: totalLoss, col: "#ff6644", icon: "💀" },
              ].map(s => (
                <div key={s.label} style={{ background: "#13161f", border: "1px solid #c9a84c1a", borderRadius: 11, padding: "11px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 15, marginBottom: 3 }}>{s.icon}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: s.col }}>{fmtS(s.val)}</div>
                  <div style={{ fontSize: 9, color: "#5a4a2a", letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              {playerNames.map((name, i) => (
                <div key={i} style={{ background: "#13161f", border: "1px solid #c9a84c1a", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}>
                    <span style={{ fontSize: 14 }}>{icons[i]}</span>
                    {editingName === i ? (
                      <input value={tempName} onChange={e => setTempName(e.target.value)}
                        onBlur={() => saveName(i, tempName)}
                        onKeyDown={e => { if (e.key === "Enter") saveName(i, tempName); }}
                        autoFocus style={{ background: "none", border: "none", borderBottom: "1px solid #c9a84c", color: "#c9a84c", fontSize: 11, fontFamily: "inherit", width: 80, outline: "none" }} />
                    ) : (
                      <span style={{ fontSize: 11, color: "#c9a84c", fontWeight: 600, cursor: "pointer" }} onClick={() => { setEditingName(i); setTempName(name); }}>{name} ✎</span>
                    )}
                  </div>
                  <div style={{ background: "#0a0f1a", border: "1px solid #2a3a5a", borderRadius: 8, padding: "9px 10px" }}>
                    <p style={{ fontSize: 9, color: "#3a5a8a", marginBottom: 3, letterSpacing: 1 }}>BANK</p>
                    <p style={{ fontSize: 18, color: bankBal[i] < 0 ? "#ff4444" : "#4a8adc", fontWeight: 700 }}>{fmtS(bankBal[i])}</p>
                    {bankBal[i] < 0 && <p style={{ fontSize: 9, color: "#8a2222", marginTop: 2 }}>⚠ debet!</p>}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background: "#0a0f1a", border: "1px solid #4a8adc33", borderRadius: 12, padding: "14px 16px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ fontSize: 10, color: "#3a5a8a", letterSpacing: 1, marginBottom: 3 }}>🏦 ŁĄCZNIE W BANKU GILDII</p>
                <p style={{ fontSize: 9, color: "#3a4a5a", fontFamily: "Georgia, serif" }}>{fmtS(bankBal[0])} + {fmtS(bankBal[1])}</p>
              </div>
              <p style={{ fontSize: 24, color: "#4a8adc", fontWeight: 700 }}>{fmtS(totalBank)}</p>
            </div>

            {events.length > 0 && (
              <button onClick={clearAll} style={{ width: "100%", background: "none", border: "1px solid #ff6b6b15", color: "#ff6b6b33", borderRadius: 8, padding: "7px", cursor: "pointer", fontSize: 9, letterSpacing: 1, fontFamily: "inherit" }}>🗑 WYCZYŚĆ WSZYSTKO</button>
            )}
          </div>
        )}

        {/* SPRZEDAŻ */}
        {tab === "sell" && (
          <div className="fade-in" style={{ background: "#13161f", border: "1px solid #8adc8a22", borderRadius: 16, padding: 20 }}>
            <h2 style={{ fontSize: 11, color: "#8adc8a", letterSpacing: 2, marginBottom: 18 }}>💰 NOWA SPRZEDAŻ BLACK MARKET</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
              <div><label style={labelStyle()}>PRZEDMIOT</label><input value={sellForm.item} onChange={e => setSellForm(f => ({ ...f, item: e.target.value }))} placeholder="np. T6 Plate Armor" style={inputStyle()} /></div>
              <div>
                <label style={labelStyle()}>KATEGORIA</label>
                <select value={sellForm.category} onChange={e => setSellForm(f => ({ ...f, category: e.target.value }))} style={inputStyle()}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle()}>CENA SPRZEDAŻY (srebro)</label>
                <input type="number" value={sellForm.amount} onChange={e => setSellForm(f => ({ ...f, amount: e.target.value }))} placeholder="np. 800000" style={inputStyle()} />
                {sellForm.amount && <p style={{ fontSize: 10, color: "#c9a84c66", marginTop: 3, fontFamily: "Georgia, serif" }}>= {fmtS(Number(sellForm.amount))}</p>}
              </div>
              <div>
                <label style={labelStyle()}>PODZIAŁ ZYSKU</label>
                <SplitPicker value={sellForm.split} onChange={v => setSellForm(f => ({ ...f, split: v }))} />
                <SplitPreview amount={sellForm.amount} split={sellForm.split} />
              </div>
              <div><label style={labelStyle()}>NOTATKA</label><input value={sellForm.note} onChange={e => setSellForm(f => ({ ...f, note: e.target.value }))} placeholder="opcjonalna..." style={inputStyle()} /></div>
              <button className="action-btn" onClick={addSell} disabled={saving} style={{ background: saving ? "#2a3a2a" : "linear-gradient(135deg,#3a7a3a,#2a5a2a)", color: "#8adc8a" }}>
                {saving ? "ZAPISYWANIE..." : "DODAJ SPRZEDAŻ"}
              </button>
            </div>
          </div>
        )}

        {/* ZAKUP */}
        {tab === "buy" && (
          <div className="fade-in">
            <div style={{ background: "#13161f", border: "1px solid #ff8a8a22", borderRadius: 16, padding: 20, marginBottom: 14 }}>
              <h2 style={{ fontSize: 11, color: "#ff8a8a", letterSpacing: 2, marginBottom: 18 }}>📦 ZAKUP ITEMÓW (z banku)</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                <div><label style={labelStyle()}>PRZEDMIOT</label><input value={buyForm.item} onChange={e => setBuyForm(f => ({ ...f, item: e.target.value }))} placeholder="np. T6 Leather, Runestone..." style={inputStyle("#ff8a8a22")} /></div>
                <div>
                  <label style={labelStyle()}>KATEGORIA</label>
                  <select value={buyForm.category} onChange={e => setBuyForm(f => ({ ...f, category: e.target.value }))} style={inputStyle("#ff8a8a22")}>
                    {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle()}>KOSZT (srebro)</label>
                  <input type="number" value={buyForm.amount} onChange={e => setBuyForm(f => ({ ...f, amount: e.target.value }))} placeholder="np. 400000" style={inputStyle("#ff8a8a22")} />
                  {buyForm.amount && <p style={{ fontSize: 10, color: "#ff8a8a55", marginTop: 3, fontFamily: "Georgia, serif" }}>= {fmtS(Number(buyForm.amount))}</p>}
                </div>
                <div>
                  <label style={labelStyle()}>PODZIAŁ KOSZTU</label>
                  <SplitPicker value={buyForm.split} onChange={v => setBuyForm(f => ({ ...f, split: v }))} />
                  <BuySplitPreview amount={buyForm.amount} split={buyForm.split} />
                </div>
                <div><label style={labelStyle()}>NOTATKA</label><input value={buyForm.note} onChange={e => setBuyForm(f => ({ ...f, note: e.target.value }))} placeholder="opcjonalna..." style={inputStyle("#ff8a8a22")} /></div>
                <button className="action-btn" onClick={addBuy} disabled={saving} style={{ background: saving ? "#2a1a1a" : "linear-gradient(135deg,#6a2a2a,#4a1a1a)", color: "#ff8a8a" }}>
                  {saving ? "ZAPISYWANIE..." : "KUP (pobierz z banku)"}
                </button>
              </div>
            </div>

            <div style={{ background: "#13161f", border: "1px solid #ff664422", borderRadius: 16, padding: 20 }}>
              <h2 style={{ fontSize: 11, color: "#ff6644", letterSpacing: 2, marginBottom: 18 }}>💀 STRATA / TRANSPORT</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                <div><label style={labelStyle()}>OPIS STRATY</label><input value={lossForm.item} onChange={e => setLossForm(f => ({ ...f, item: e.target.value }))} placeholder="np. Killed during transport..." style={inputStyle("#ff664422")} /></div>
                <div>
                  <label style={labelStyle()}>WARTOŚĆ STRATY (srebro)</label>
                  <input type="number" value={lossForm.amount} onChange={e => setLossForm(f => ({ ...f, amount: e.target.value }))} placeholder="np. 200000" style={inputStyle("#ff664422")} />
                  {lossForm.amount && <p style={{ fontSize: 10, color: "#ff664455", marginTop: 3, fontFamily: "Georgia, serif" }}>= {fmtS(Number(lossForm.amount))}</p>}
                </div>
                <div>
                  <label style={labelStyle()}>PODZIAŁ STRATY</label>
                  <SplitPicker value={lossForm.split} onChange={v => setLossForm(f => ({ ...f, split: v }))} />
                  <BuySplitPreview amount={lossForm.amount} split={lossForm.split} />
                </div>
                <div><label style={labelStyle()}>NOTATKA</label><input value={lossForm.note} onChange={e => setLossForm(f => ({ ...f, note: e.target.value }))} placeholder="opcjonalna..." style={inputStyle("#ff664422")} /></div>
                <button className="action-btn" onClick={addLoss} disabled={saving} style={{ background: saving ? "#1a1510" : "linear-gradient(135deg,#6a3020,#4a1a10)", color: "#ff8866" }}>
                  {saving ? "ZAPISYWANIE..." : "ZAPISZ STRATĘ"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* BANK */}
        {tab === "bank" && (
          <div className="fade-in">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              {playerNames.map((name, i) => (
                <div key={i} style={{ background: "#0a0f1a", border: "1px solid #4a8adc33", borderRadius: 12, padding: 14 }}>
                  <p style={{ fontSize: 10, color: "#4a8adc88", marginBottom: 6 }}>{icons[i]} {name}</p>
                  <p style={{ fontSize: 9, color: "#3a5a7a", marginBottom: 2 }}>BANK</p>
                  <p style={{ fontSize: 15, color: bankBal[i] < 0 ? "#ff4444" : "#4a8adc", fontWeight: 700 }}>{fmtS(bankBal[i])}</p>
                </div>
              ))}
            </div>

            <div style={{ background: "#13161f", border: "1px solid #4a8adc22", borderRadius: 14, padding: 20 }}>
              <h2 style={{ fontSize: 11, color: "#4a8adc", letterSpacing: 2, marginBottom: 16 }}>🏦 OPERACJA BANKOWA</h2>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 14 }}>
                {[
                  ["external_deposit", "🪄 Z zewnątrz → Bank", "korekta / gotówka → bank"],
                  ["withdraw", "⬇ Wypłać z banku", "bank → portfel"]
                ].map(([val, label, sub]) => (
                  <button key={val} className="tab-btn" onClick={() => setBankForm(f => ({ ...f, subtype: val }))} style={{
                    padding: "11px 6px", borderRadius: 9,
                    background: bankForm.subtype === val ? "#0a0f1a" : "#0d0f14",
                    border: `1px solid ${bankForm.subtype === val ? "#4a8adc88" : "#4a8adc1a"}`,
                    color: bankForm.subtype === val ? "#4a8adc" : "#6a5a3a",
                    fontFamily: "inherit", fontSize: 10, textAlign: "center"
                  }}>
                    <div style={{ fontWeight: 700 }}>{label}</div>
                    <div style={{ fontSize: 9, opacity: 0.6, marginTop: 2 }}>{sub}</div>
                  </button>
                ))}
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle()}>GRACZ</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
                  {playerNames.map((name, i) => (
                    <button key={i} className="tab-btn" onClick={() => setBankForm(f => ({ ...f, player: i }))} style={{ padding: "10px", borderRadius: 8, background: bankForm.player === i ? "#0a0f1a" : "#0d0f14", border: `1px solid ${bankForm.player === i ? "#4a8adc88" : "#4a8adc1a"}`, color: bankForm.player === i ? "#4a8adc" : "#6a5a3a", fontSize: 11, fontFamily: "inherit" }}>{icons[i]} {name}</button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle()}>KWOTA</label>
                <input type="number" value={bankForm.amount} onChange={e => setBankForm(f => ({ ...f, amount: e.target.value }))} placeholder="np. 500000" style={inputStyle("#4a8adc33")} />
                {bankForm.amount && !isNaN(Number(bankForm.amount)) && (
                  <div style={{ marginTop: 6, fontSize: 10, color: "#4a8adc88", fontFamily: "Georgia, serif" }}>
                    = {fmtS(Number(bankForm.amount))}
                    {bankForm.subtype === "withdraw" && ` · bank ${playerNames[bankForm.player]}: ${fmtS(bankBal[bankForm.player])}`}
                    {bankForm.subtype === "external_deposit" && ` · bank ${playerNames[bankForm.player]}: ${fmtS(bankBal[bankForm.player])}`}
                  </div>
                )}
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle()}>NOTATKA</label>
                <input value={bankForm.note} onChange={e => setBankForm(f => ({ ...f, note: e.target.value }))} placeholder="opcjonalna..." style={inputStyle("#4a8adc33")} />
              </div>
              <button className="action-btn" onClick={addBankAction} disabled={saving} style={{ background: saving ? "#1a2030" : "linear-gradient(135deg,#2a5a9c,#1a3a6c)", color: "#8abcec" }}>
                {saving ? "ZAPISYWANIE..." : {
                  external_deposit: "🪄 WPŁAĆ Z ZEWNĄTRZ DO BANKU",
                  withdraw: "⬇ WYPŁAĆ Z BANKU",
                }[bankForm.subtype] || "WYKONAJ"}
              </button>
            </div>
          </div>
        )}

        {/* HISTORIA */}
        {tab === "history" && (
          <div className="fade-in">
            <h2 style={{ fontSize: 11, color: "#c9a84c", letterSpacing: 2, marginBottom: 14 }}>HISTORIA ({events.length})</h2>
            {events.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", color: "#5a4a2a", fontFamily: "Georgia, serif", fontStyle: "italic" }}>Brak wpisów</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {[...events].sort((a, b) => b.id - a.id).map(ev => {
                  const col = typeColors[ev.type] || "#c9a84c";
                  const lbl = typeLabels[ev.type] || ev.type;
                  const isSell = ev.type === "sell";
                  const isBuy = ev.type === "buy";
                  const isLoss = ev.type === "loss";
                  const isBank = ev.type === "withdraw" || ev.type === "external_deposit";
                  const sign = isSell ? "+" : (isBuy || isLoss) ? "-" : ev.type === "external_deposit" ? "🪄" : "↓";
                  return (
                    <div key={ev.id} className="tx-row" style={{ background: "#13161f", border: "1px solid #c9a84c0f", borderLeft: `3px solid ${col}`, borderRadius: "0 9px 9px 0", padding: "9px 11px", display: "flex", alignItems: "flex-start", gap: 9 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 9, color: col }}>{lbl}</span>
                          {(isSell || isBuy || isLoss) && ev.split && <><span style={{ fontSize: 9, color: "#3a2a1a" }}>·</span><span style={{ fontSize: 9, color: "#c9a84c44" }}>{splitLabel(ev.split, playerNames)}</span></>}
                          {isBank && <><span style={{ fontSize: 9, color: "#3a2a1a" }}>·</span><span style={{ fontSize: 9, color: "#4a8adc88" }}>{playerNames[ev.player]}</span></>}
                          {ev.category && <><span style={{ fontSize: 9, color: "#3a2a1a" }}>·</span><span style={{ fontSize: 9, color: "#3a2a1a" }}>{ev.category}</span></>}
                        </div>
                        <div style={{ fontSize: 12, color: "#ddd0b8", marginTop: 2, fontFamily: "Georgia, serif" }}>
                          {ev.item || ev.note || "—"}
                          {ev.item && ev.note && <span style={{ color: "#6a5a3a", fontSize: 11 }}> · {ev.note}</span>}
                        </div>
                        {(isSell || isBuy || isLoss) && ev.amount > 0 && (
                          <div style={{ display: "flex", gap: 10, marginTop: 2 }}>
                            {playerNames.map((name, i) => {
                              const sh = splitShares(ev.amount, ev.split, playerNames)[i];
                              return sh > 0 ? <span key={i} style={{ fontSize: 9, color: isSell ? "#3a6a3a" : "#6a3a3a" }}>{icons[i]} {fmtS(sh)}</span> : null;
                            })}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: "#2a1a0a", marginTop: 1 }}>{ev.date}</div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: col, flexShrink: 0, paddingTop: 2 }}>{sign}{fmtS(ev.amount)}</div>
                      <button className="del-btn" onClick={() => deleteEvent(ev.id)}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
