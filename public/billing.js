// Billing Page JavaScript
// FastLectures Billing - Handles subscription, payment, and billing history

(function() {
  "use strict";

  const API_BASE = "/api/billing";

  // State management
  let state = {
    billingData: {},
    paymentHistory: [],
    isLoading: false
  };

  // DOM Elements
  const DOM = {
    billingPlanBadge: document.getElementById("billing-plan-badge"),
    billingPlanDesc: document.getElementById("billing-plan-desc"),
    nextBillingDate: document.getElementById("next-billing-date"),
    paymentMethod: document.getElementById("payment-method"),
    paymentMethodExpiry: document.getElementById("payment-method-expiry"),
    paymentIconVisa: document.getElementById("payment-icon-visa"),
    lifetimeValue: document.getElementById("lifetime-value"),
    billingHistoryBody: document.getElementById("billing-history-body"),
    emptyBillingHistory: document.getElementById("empty-billing-history"),
    billingHistoryHistoryBtn: document.getElementById("billing-history-btn"),
    // Modals
    cancelModal: document.getElementById("cancel-modal"),
    paymentModal: document.getElementById("payment-modal"),
    planModal: document.getElementById("plan-modal"),
    closeCancelModal: document.getElementById("close-cancel-modal"),
    closePaymentModal: document.getElementById("close-payment-modal"),
    closePlanModal: document.getElementById("close-plan-modal"),
    keepSubscriptionBtn: document.getElementById("keep-subscription-btn"),
    confirmCancelBtn: document.getElementById("confirm-cancel-btn"),
    cancelPaymentBtn: document.getElementById("cancel-payment-btn"),
    redirectStripeBtn: document.getElementById("redirect-stripe-btn"),
    // Account menu
    accountBtn: document.getElementById("billing-account-btn"),
    accountMenu: document.getElementById("billing-account-menu"),
    userName: document.getElementById("billing-user-name"),
    // Buttons
    changePlanBtn: document.getElementById("change-plan-btn"),
    cancelSubscriptionBtn: document.getElementById("cancel-subscription-btn"),
    updatePaymentBtn: document.getElementById("update-payment-btn"),
    billingHistoryHistoryBtn: document.getElementById("billing-history-btn")
  };

  // Check if user is authenticated
  async function checkAuth() {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          window.location.href = "/login.html";
          return false;
        }
        throw new Error("Authentication check failed");
      }

      const data = await response.json();
      if (data.user) {
        DOM.userName.textContent = data.user.name || data.user.email;
      }

      return true;
    } catch (err) {
      window.location.href = "/login.html";
      return false;
    }
  }

  // Fetch billing data
  async function fetchData() {
    if (state.isLoading) return;
    state.isLoading = true;

    try {
      // Fetch billing info
      const billingResp = await fetch(`${API_BASE}`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (billingResp.ok) {
        state.billingData = await billingResp.json();
      }

      // Fetch payment history
      const historyResp = await fetch(`${API_BASE}/history`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (historyResp.ok) {
        state.paymentHistory = await historyResp.json();
      }
    } catch (err) {
      console.error("Failed to fetch billing data:", err);
    } finally {
      state.isLoading = false;
    }
  }

  // Render billing info
  function renderBilling() {
    const billing = state.billingData || {};

    // Current Plan
    DOM.billingPlanBadge.textContent = billing.plan || "Individual";
    DOM.billingPlanBadge.textContent = DOM.billingPlanBadge.textContent.charAt(0).toUpperCase() + DOM.billingPlanBadge.textContent.slice(1);
    DOM.billingPlanDesc.textContent = billing.plan_name || `${DOM.billingPlanBadge.textContent} plan`;
    DOM.billingPlanBadge.dataset.plan = billing.plan || "individual";

    // Next billing date
    if (billing.next_billing_date) {
      DOM.nextBillingDate.textContent = new Date(billing.next_billing_date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } else {
      DOM.nextBillingDate.textContent = "—";
    }

    // Payment method
    if (billing.payment_method && billing.payment_method !== "not_set") {
      const cardType = billing.payment_method.card_type || "Visa";
      const last4 = billing.payment_method.card_last4 || "";
      const expiry = billing.payment_method.card_expiry || "";
      DOM.paymentMethod.textContent = `${cardType} ending in ${last4}`;
      DOM.paymentMethodExpiry.textContent = `Expires ${expiry}`;
      if (cardType.toLowerCase().includes("visa")) {
        DOM.paymentIconVisa.textContent = "💳 Visa";
        DOM.paymentIconVisa.hidden = false;
      }
    } else {
      DOM.paymentMethod.textContent = "Not set";
      DOM.paymentMethodExpiry.textContent = "Add a payment method";
    }

    // Lifetime value
    DOM.lifetimeValue.textContent = `$${(billing.lifetime_value || 0).toFixed(2)}`;
  }

  // Render billing history table
  function renderBillingHistory() {
    if (!state.paymentHistory || state.paymentHistory.length === 0) {
      DOM.billingHistoryBody.style.display = "none";
      DOM.emptyBillingHistory.style.display = "flex";
      return;
    }

    DOM.billingHistoryBody.style.display = "table-row-group";
    DOM.emptyBillingHistory.style.display = "none";

    DOM.billingHistoryBody.innerHTML = state.paymentHistory.map(payment => {
      const date = new Date(payment.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      const statusClass = payment.status === "paid" ? "billing-status-paid" : payment.status === "pending" ? "billing-status-pending" : "billing-status-failed";
      const statusText = payment.status === "paid" ? "Paid" : payment.status === "pending" ? "Pending" : "Failed";

      return `
        <tr data-payment-id="${payment.id}">
          <td>${date}</td>
          <td>${escapeHtml(payment.plan || "—")}</td>
          <td><span class="user-status ${statusClass}">${statusText}</span></td>
          <td>$${payment.amount.toFixed(2)}</td>
          <td>
            <button class="btn-ghost billing-receipt-btn" type="button" data-payment-id="${payment.id}">
              Receipt
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Open cancel subscription modal
  function openCancelModal() {
    DOM.cancelModal.showModal();
  }

  // Close cancel modal
  function closeCancelModal() {
    DOM.cancelModal.close();
  }

  // Handle cancel subscription
  async function handleCancelSubscription() {
    try {
      const response = await fetch(`${API_BASE}/cancel`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ reason: document.getElementById("cancel-reason").value || undefined })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to cancel subscription");
      }

      DOM.cancelModal.close();
      // Refresh billing data
      await fetchData();
      renderBilling();
    } catch (err) {
      console.error("Failed to cancel subscription:", err);
      alert("Failed to cancel subscription. Please try again.");
    }
  }

  // Open update payment modal
  function openPaymentModal() {
    DOM.paymentModal.showModal();
  }

  // Close update payment modal
  function closePaymentModal() {
    DOM.paymentModal.close();
  }

  // Handle update payment method
  function handleUpdatePayment() {
    window.location.href = "/settings";
  }

  // Open change plan modal
  function openPlanModal() {
    DOM.planModal.showModal();
  }

  // Close change plan modal
  function closePlanModal() {
    DOM.planModal.close();
  }

  // Handle plan change
  async function handlePlanChange(e) {
    e.preventDefault();

    const selectedPlan = document.querySelector('input[name="plan"]:checked');
    if (!selectedPlan) return;

    const plan = selectedPlan.value;

    try {
      const response = await fetch(`${API_BASE}/plan`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ plan })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to change plan");
      }

      DOM.planModal.close();
      await fetchData();
      renderBilling();
    } catch (err) {
      console.error("Failed to change plan:", err);
      alert("Failed to change plan. Please try again.");
    }
  }

  // Toggle account menu
  function toggleAccountMenu() {
    const isHidden = DOM.accountMenu.hidden;
    DOM.accountMenu.hidden = !isHidden;
    DOM.accountMenu.setAttribute("aria-hidden", !isHidden);
    DOM.accountBtn.setAttribute("aria-expanded", isHidden);
  }

  // Close account menu on outside click
  function handleAccountClick(e) {
    if (!DOM.accountMenu.contains(e.target) && !DOM.accountBtn.contains(e.target)) {
      DOM.accountMenu.hidden = true;
      DOM.accountMenu.setAttribute("aria-hidden", true);
      DOM.accountBtn.setAttribute("aria-expanded", false);
    }
  }

  // Event Listeners
  function setupEventListeners() {
    // Account menu toggle
    DOM.accountBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAccountMenu();
    });

    document.addEventListener("click", handleAccountClick);

    // Account menu items
    DOM.accountMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".billing-account-item");
      if (!item) return;

      const action = item.dataset.accountAction;
      DOM.accountMenu.hidden = true;
      DOM.accountMenu.setAttribute("aria-hidden", true);
      DOM.accountBtn.setAttribute("aria-expanded", false);

      if (action === "signout") {
        window.location.href = "/login.html";
      } else if (action === "billing") {
        window.location.href = "/billing.html";
      } else if (action === "subscription") {
        window.location.href = "/billing.html";
      }
    });

    // Cancel subscription modal
    DOM.cancelSubscriptionBtn.addEventListener("click", openCancelModal);
    DOM.closeCancelModal.addEventListener("click", closeCancelModal);
    DOM.keepSubscriptionBtn.addEventListener("click", closeCancelModal);
    DOM.confirmCancelBtn.addEventListener("click", handleCancelSubscription);

    // Payment modal
    DOM.updatePaymentBtn.addEventListener("click", openPaymentModal);
    DOM.closePaymentModal.addEventListener("click", closePaymentModal);
    DOM.cancelPaymentBtn.addEventListener("click", closePaymentModal);
    DOM.redirectStripeBtn.addEventListener("click", handleUpdatePayment);

    // Plan modal
    DOM.changePlanBtn.addEventListener("click", openPlanModal);
    DOM.closePlanModal.addEventListener("click", closePlanModal);
    DOM.planModal.addEventListener("submit", handlePlanChange);

    // Billing history
    DOM.billingHistoryHistoryBtn.addEventListener("click", () => {
      window.location.href = "/billing.html";
    });

    // Receipt button delegation
    DOM.billingHistoryBody.addEventListener("click", (e) => {
      const receiptBtn = e.target.closest(".billing-receipt-btn");
      if (receiptBtn) {
        const paymentId = receiptBtn.dataset.paymentId;
        window.open(`/api/billing/receipt/${paymentId}`, "_blank");
      }
    });
  }

  // Initialize
  async function init() {
    const isAuthenticated = await checkAuth();
    if (!isAuthenticated) return;

    await fetchData();
    renderBilling();
    renderBillingHistory();
    setupEventListeners();
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();