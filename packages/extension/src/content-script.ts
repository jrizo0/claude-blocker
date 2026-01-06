export {};

const DEFAULT_DOMAINS = ["x.com", "youtube.com"];

// Work hours settings
interface WorkHoursSettings {
  enabled: boolean;
  startTime: string;
  endTime: string;
  days: number[];
}

const DEFAULT_WORK_HOURS: WorkHoursSettings = {
  enabled: true,
  startTime: "10:00",
  endTime: "17:00",
  days: [1, 2, 3, 4, 5],
};

// State shape from service worker
interface PublicState {
  serverConnected: boolean;
  sessions: number;
  working: number;
  waitingForInput: number;
  blocked: boolean;
  bypassActive: boolean;
}

// Track state
let lastKnownState: PublicState | null = null;
let isPageBlocked = false;
let blockedDomains: string[] = [];
let workHours: WorkHoursSettings = DEFAULT_WORK_HOURS;

// Blocked page HTML - replaces entire document
const BLOCKED_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Blocked - Claude Blocker</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      background: #0a0a0a;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Arial, Helvetica, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 16px;
      padding: 40px;
      max-width: 480px;
      text-align: center;
    }
    .lock-icon {
      width: 64px;
      height: 64px;
      margin-bottom: 24px;
    }
    h1 {
      color: #fff;
      font-size: 24px;
      font-weight: bold;
      margin-bottom: 16px;
    }
    .message {
      color: #888;
      font-size: 16px;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: #2a2a2a;
      border-radius: 20px;
      font-size: 14px;
      color: #666;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #666;
    }
    .dot.green {
      background: #22c55e;
      box-shadow: 0 0 8px #22c55e;
    }
    .dot.red {
      background: #ef4444;
      box-shadow: 0 0 8px #ef4444;
    }
    .hint {
      margin-top: 24px;
      font-size: 13px;
      color: #555;
      line-height: 1.4;
    }
    .hint code {
      background: #2a2a2a;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    .bypass-btn {
      margin-top: 24px;
      padding: 12px 24px;
      background: #333;
      border: 1px solid #444;
      border-radius: 8px;
      color: #888;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .bypass-btn:hover:not(:disabled) {
      background: #444;
      color: #aaa;
    }
    .bypass-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="container">
    <svg class="lock-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="11" width="18" height="11" rx="2" fill="#FFD700" stroke="#B8860B" stroke-width="1"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="#888" stroke-width="2" fill="none"/>
    </svg>
    <h1>Time to Work</h1>
    <p id="message" class="message">Loading...</p>
    <div class="status-badge">
      <span id="dot" class="dot"></span>
      <span id="status">...</span>
    </div>
    <p id="hint" class="hint"></p>
    <button id="bypass-btn" class="bypass-btn">Give me 5 minutes (1x per day)</button>
  </div>
</body>
</html>
`;

// Load domains from storage
function loadDomains(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["blockedDomains"], (result) => {
      if (result.blockedDomains && Array.isArray(result.blockedDomains)) {
        resolve(result.blockedDomains);
      } else {
        resolve(DEFAULT_DOMAINS);
      }
    });
  });
}

// Load work hours from storage
function loadWorkHours(): Promise<WorkHoursSettings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["workHours"], (result) => {
      if (result.workHours) {
        resolve(result.workHours);
      } else {
        resolve(DEFAULT_WORK_HOURS);
      }
    });
  });
}

// Check if current time is within work hours
function isWithinWorkHours(): boolean {
  if (!workHours.enabled) return true; // If disabled, always allow blocking

  const now = new Date();
  const currentDay = now.getDay();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  // Check if today is a work day
  if (!workHours.days.includes(currentDay)) {
    return false;
  }

  // Parse start and end times
  const [startHour, startMin] = workHours.startTime.split(":").map(Number);
  const [endHour, endMin] = workHours.endTime.split(":").map(Number);
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  return currentTime >= startMinutes && currentTime < endMinutes;
}

function isBlockedDomain(): boolean {
  const hostname = window.location.hostname.replace(/^www\./, "");
  return blockedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

// Block the page by replacing all content
function blockPage(): void {
  if (isPageBlocked) return;

  // Stop loading any pending resources (videos, scripts, etc.)
  window.stop();

  // Replace entire document - use innerHTML for async contexts
  // document.write() doesn't work reliably when called asynchronously
  document.documentElement.innerHTML = BLOCKED_PAGE_HTML;

  isPageBlocked = true;

  // Setup bypass button (need small delay for DOM to be ready)
  setTimeout(() => {
    const bypassBtn = document.getElementById("bypass-btn");
    if (bypassBtn) {
      // Check if already used today
      chrome.runtime.sendMessage({ type: "GET_BYPASS_STATUS" }, (status) => {
        if (status?.usedToday) {
          bypassBtn.textContent = "Bypass already used today";
          (bypassBtn as HTMLButtonElement).disabled = true;
        }
      });

      bypassBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "ACTIVATE_BYPASS" }, (response) => {
          if (response?.success) {
            // Reload to show the actual page
            location.reload();
          } else if (response?.reason) {
            bypassBtn.textContent = response.reason;
            (bypassBtn as HTMLButtonElement).disabled = true;
          }
        });
      });
    }

    // Render current state if available
    if (lastKnownState) {
      renderState(lastKnownState);
    }
  }, 0);
}

// Unblock by reloading the page
function unblockPage(): void {
  if (!isPageBlocked) return;
  location.reload();
}

function renderState(state: PublicState): void {
  const message = document.getElementById("message");
  const dot = document.getElementById("dot");
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");

  if (!message || !dot || !status || !hint) return;

  if (!state.serverConnected) {
    message.textContent = "Server offline. Start the blocker server to continue.";
    dot.className = "dot red";
    status.textContent = "Server Offline";
    hint.innerHTML = `Run <code>npx claude-blocker</code> to start`;
  } else if (state.sessions === 0) {
    message.textContent = "No Claude Code sessions detected.";
    dot.className = "dot green";
    status.textContent = "Waiting for Claude Code";
    hint.textContent = "Open a terminal and start Claude Code";
  } else {
    message.textContent = "Your job finished!";
    dot.className = "dot green";
    status.textContent = `${state.sessions} session${state.sessions > 1 ? "s" : ""} idle`;
    hint.textContent = "Type a prompt in Claude Code to unblock";
  }
}

// Handle state updates from service worker
function handleState(state: PublicState): void {
  lastKnownState = state;

  if (!isBlockedDomain()) {
    return;
  }

  if (state.blocked) {
    if (!isPageBlocked) {
      blockPage();
    } else {
      renderState(state);
    }
  } else {
    // Not blocked - reload to show actual page
    if (isPageBlocked) {
      unblockPage();
    }
  }
}

// Request state from service worker
function requestState(): void {
  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Service worker not ready, retry
      setTimeout(requestState, 500);
      return;
    }
    handleState(response);
  });
}

// Listen for broadcasts from service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") {
    handleState(message);
  }
  if (message.type === "DOMAINS_UPDATED") {
    blockedDomains = message.domains;
    if (lastKnownState) {
      handleState(lastKnownState);
    }
  }
});

// Initialize - check state before blocking
async function init(): Promise<void> {
  // Load settings in parallel
  const [domains, hours] = await Promise.all([loadDomains(), loadWorkHours()]);
  blockedDomains = domains;
  workHours = hours;

  if (isBlockedDomain() && isWithinWorkHours()) {
    // Don't block immediately - wait for actual state from service worker
    // This prevents reload loops when Claude is working
    requestState();
  }
}

init();
