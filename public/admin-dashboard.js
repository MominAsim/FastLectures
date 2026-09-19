// Admin Dashboard JavaScript
// FastLectures Admin Panel - Handles school and user management

(function() {
  "use strict";

  const API_BASE = "/api/admin";

  // State management
  let state = {
    schools: [],
    users: [],
    billing: {},
    recentPayments: [],
    filteredUsers: [],
    isLoading: false
  };

  // DOM Elements
  const DOM = {
    // Schools
    schoolsList: document.getElementById("schools-list"),
    emptySchools: document.getElementById("empty-schools"),

    // Users
    usersTableBody: document.getElementById("users-table-body"),
    emptyUsers: document.getElementById("empty-users"),
    userSearch: document.getElementById("user-search"),

    // Stats
    statSchoolsCount: document.getElementById("stat-schools-count"),
    statUsersCount: document.getElementById("stat-users-count"),
    statRevenue: document.getElementById("stat-revenue"),
    statPending: document.getElementById("stat-pending"),

    // Billing
    billingTotal: document.getElementById("billing-total"),
    billingSubscriptions: document.getElementById("billing-subscriptions"),
    billingStudents: document.getElementById("billing-students"),
    billingOutstanding: document.getElementById("billing-outstanding"),
    recentPaymentsBody: document.getElementById("recent-payments-body"),
    recentPaymentsEmpty: document.getElementById("recent-payments-empty"),

    // Modals
    addSchoolModal: document.getElementById("add-school-modal"),
    deleteSchoolModal: document.getElementById("delete-school-modal"),
    addSchoolForm: document.getElementById("add-school-form"),
    deleteSchoolName: document.getElementById("delete-school-name"),
    closeModalBtn: document.getElementById("close-modal-btn"),
    closeDeleteModalBtn: document.getElementById("close-delete-modal-btn"),
    cancelDeleteBtn: document.getElementById("cancel-delete-btn"),
    confirmDeleteBtn: document.getElementById("confirm-delete-btn"),

    // Errors
    addSchoolError: document.getElementById("add-school-error"),
    deleteSchoolError: document.getElementById("delete-school-error"),

    // Navigation
    navItems: document.querySelectorAll(".admin-nav-item"),

    // Logout
    logoutBtn: document.getElementById("admin-logout-btn")
  };

  // Check if user is admin
  async function checkAuth() {
    try {
      const response = await fetch(`${API_BASE}/me`, {
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
      if (!data.user || data.user.role !== "admin") {
        window.location.href = "/login.html";
        return false;
      }

      return true;
    } catch (err) {
      window.location.href = "/login.html";
      return false;
    }
  }

  // Fetch all data
  async function fetchData() {
    if (state.isLoading) return;
    state.isLoading = true;

    try {
      // Fetch schools
      const schoolsResp = await fetch(`${API_BASE}/schools`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (schoolsResp.ok) {
        state.schools = await schoolsResp.json();
      }

      // Fetch users
      const usersResp = await fetch(`${API_BASE}/users`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (usersResp.ok) {
        state.users = await usersResp.json();
        state.filteredUsers = [...state.users];
      }

      // Fetch billing
      const billingResp = await fetch(`${API_BASE}/billing`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (billingResp.ok) {
        state.billing = await billingResp.json();
      }

      // Fetch recent payments
      const paymentsResp = await fetch(`${API_BASE}/billing/payments?limit=10`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (paymentsResp.ok) {
        state.recentPayments = await paymentsResp.json();
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      state.isLoading = false;
    }
  }

  // Render schools
  function renderSchools() {
    if (state.schools.length === 0) {
      DOM.schoolsList.style.display = "none";
      DOM.emptySchools.style.display = "flex";
      return;
    }

    DOM.schoolsList.style.display = "grid";
    DOM.emptySchools.style.display = "none";

    DOM.schoolsList.innerHTML = state.schools.map(school => {
      const studentCount = school.student_count || 0;
      const revenue = (school.monthly_revenue || 0).toFixed(2);
      const verified = school.is_verified ? "Verified" : "Pending";
      const verifiedColor = school.is_verified ? "var(--success)" : "var(--danger)";

      return `
        <div class="admin-school-card" data-school-id="${school.id}">
          <div class="admin-school-header">
            <h3 class="admin-school-name">${escapeHtml(school.name)}</h3>
            <button class="admin-school-actions" type="button" aria-label="School options">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm1 8H9v-2h4v-4H9V6h4V4H9a6 6 0 0 0-6 6v8h14V8h-2v4z"/></svg>
            </button>
          </div>
          <div class="admin-school-body">
            <div class="admin-school-stats">
              <div class="admin-school-stat">
                <span class="admin-school-stat-value">${studentCount}</span>
                <span class="admin-school-stat-label">Students</span>
              </div>
              <div class="admin-school-stat">
                <span class="admin-school-stat-value">$${revenue}</span>
                <span class="admin-school-stat-label">Revenue</span>
              </div>
              <div class="admin-school-stat">
                <span class="admin-school-stat-value" style="color: ${verifiedColor}">${verified}</span>
                <span class="admin-school-stat-label">Status</span>
              </div>
            </div>
            <p class="admin-school-email">${escapeHtml(school.email || "—")}</p>
          </div>
          <button class="btn-ghost admin-school-view-btn" type="button" data-school-id="${school.id}">
            View details
          </button>
        </div>
      `;
    }).join("");
  }

  // Render users table
  function renderUsers() {
    if (state.filteredUsers.length === 0) {
      DOM.usersTableBody.style.display = "none";
      DOM.emptyUsers.style.display = "flex";
      return;
    }

    DOM.usersTableBody.style.display = "table-row-group";
    DOM.emptyUsers.style.display = "none";

    DOM.usersTableBody.innerHTML = state.filteredUsers.map(user => {
      const roleClass = `role-${user.role}`;
      const statusClass = user.is_active ? "status-active" : "status-inactive";
      const statusText = user.is_active ? "Active" : "Inactive";

      return `
        <tr data-user-id="${user.id}">
          <td>
            <span class="user-name">${escapeHtml(user.name || user.email.split("@")[0])}</span>
          </td>
          <td>${escapeHtml(user.email)}</td>
          <td>
            <select class="user-role-select" data-user-id="${user.id}">
              <option value="student" ${user.role === "student" ? "selected" : ""}>Student</option>
              <option value="teacher" ${user.role === "teacher" ? "selected" : ""}>Teacher</option>
              <option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option>
            </select>
          </td>
          <td>${user.school ? escapeHtml(user.school.name) : "Unassigned"}</td>
          <td><span class="user-status ${statusClass}">${statusText}</span></td>
          <td>
            <button class="btn-ghost user-action-btn" type="button" data-action="reset-password" data-user-id="${user.id}" aria-label="Reset password">
              Reset password
            </button>
            <button class="btn-danger user-action-btn" type="button" data-action="delete" data-user-id="${user.id}" aria-label="Delete user">
              Delete
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  // Render stats
  function renderStats() {
    const schoolCount = state.schools.length;
    const userCount = state.users.length;
    const totalStudents = state.users.filter(u => u.role === "student").length;
    const activeSchools = state.schools.filter(s => s.is_verified).length;

    DOM.statSchoolsCount.textContent = activeSchools;
    DOM.statUsersCount.textContent = userCount;

    const totalRevenue = state.billing?.total_revenue || 0;
    DOM.statRevenue.textContent = `$${totalRevenue.toFixed(2)}`;

    const pendingCount = state.schools.filter(s => !s.is_verified).length;
    DOM.statPending.textContent = pendingCount;
  }

  // Render billing
  function renderBilling() {
    const billing = state.billing || {};

    DOM.billingTotal.textContent = `$${billing.total_mrr?.toFixed(2) || "0.00"}`;
    DOM.billingSubscriptions.textContent = billing.active_subscriptions || 0;
    DOM.billingStudents.textContent = billing.total_students || 0;
    DOM.billingOutstanding.textContent = `$${billing.outstanding?.toFixed(2) || "0.00"}`;

    if (state.recentPayments && state.recentPayments.length > 0) {
      DOM.recentPaymentsEmpty.style.display = "none";
      DOM.recentPaymentsBody.innerHTML = state.recentPayments.map(payment => {
        const date = new Date(payment.date).toLocaleDateString();
        return `
          <tr>
            <td>${date}</td>
            <td>${escapeHtml(payment.school_name || "—")}</td>
            <td>$${payment.amount.toFixed(2)}</td>
          </tr>
        `;
      }).join("");
    } else {
      DOM.recentPaymentsEmpty.style.display = "flex";
      DOM.recentPaymentsBody.innerHTML = "";
    }
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Search users
  function filterUsers() {
    const query = DOM.userSearch.value.toLowerCase().trim();
    if (!query) {
      state.filteredUsers = [...state.users];
    } else {
      state.filteredUsers = state.users.filter(user =>
        (user.name && user.name.toLowerCase().includes(query)) ||
        user.email.toLowerCase().includes(query)
      );
    }
    renderUsers();
  }

  // Add school
  async function handleAddSchool(e) {
    e.preventDefault();

    const form = e.target;
    const name = document.getElementById("new-school-name").value.trim();
    const email = document.getElementById("new-school-email").value.trim();
    const address = document.getElementById("new-school-address").value.trim();
    const code = document.getElementById("new-school-code").value.trim() || undefined;

    // Validate email domain
    if (!/\.(edu|school)(?:\.|$)/i.test(email)) {
      DOM.addSchoolError.textContent = "School email must use an .edu or .school domain.";
      DOM.addSchoolError.hidden = false;
      return;
    }

    DOM.addSchoolError.hidden = true;

    try {
      const response = await fetch(`${API_BASE}/schools`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ name, email, address, code })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to add school");
      }

      await fetchData();
      renderSchools();
      DOM.addSchoolModal.close();
      form.reset();
    } catch (err) {
      DOM.addSchoolError.textContent = err.message || "Failed to add school";
      DOM.addSchoolError.hidden = false;
    }
  }

  // Open school deletion modal
  function openDeleteModal(schoolId) {
    const school = state.schools.find(s => s.id === schoolId);
    if (!school) return;

    DOM.deleteSchoolName.textContent = `Delete ${escapeHtml(school.name)}?`;
    DOM.deleteSchoolError.hidden = true;

    DOM.deleteSchoolModal.showModal();
    DOM.confirmDeleteBtn.dataset.schoolId = schoolId;
  }

  // Delete school
  async function handleDeleteSchool() {
    const schoolId = DOM.confirmDeleteBtn.dataset.schoolId;
    if (!schoolId) return;

    try {
      const response = await fetch(`${API_BASE}/schools/${schoolId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete school");
      }

      await fetchData();
      renderSchools();
      DOM.deleteSchoolModal.close();
    } catch (err) {
      DOM.deleteSchoolError.textContent = err.message || "Failed to delete school";
      DOM.deleteSchoolError.hidden = false;
    }
  }

  // Change user role
  async function handleRoleChange(e) {
    const select = e.target;
    const userId = select.dataset.userId;
    const newRole = select.value;

    try {
      const response = await fetch(`${API_BASE}/users/${userId}/role`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ role: newRole })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update role");
      }

      await fetchData();
      renderUsers();
    } catch (err) {
      console.error("Failed to update role:", err);
      // Reset select
      location.reload();
    }
  }

  // Logout
  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
    } catch (err) {
      // Continue with logout even if API fails
    }
    window.location.href = "/login.html";
  }

  // Event Listeners
  function setupEventListeners() {
    // Search users
    DOM.userSearch.addEventListener("input", filterUsers);

    // Add school modal
    document.getElementById("add-school-btn").addEventListener("click", () => {
      DOM.addSchoolModal.showModal();
      DOM.addSchoolForm.addEventListener("submit", handleAddSchool, { once: true });
    });

    // Close modal buttons
    DOM.closeModalBtn.addEventListener("click", () => {
      DOM.addSchoolModal.close();
    });

    // Delete school modal
    DOM.cancelDeleteBtn.addEventListener("click", () => {
      DOM.deleteSchoolModal.close();
    });

    DOM.closeDeleteModalBtn.addEventListener("click", () => {
      DOM.deleteSchoolModal.close();
    });

    DOM.confirmDeleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleDeleteSchool();
    });

    // Navigation
    DOM.navItems.forEach(item => {
      item.addEventListener("click", (e) => {
        const nav = item.dataset.nav;
        if (nav === "dashboard") {
          DOM.navItems.forEach(i => i.classList.remove("admin-nav-item-active"));
          item.classList.add("admin-nav-item-active");
        } else if (nav === "logout") {
          handleLogout();
        } else {
          // Navigate to appropriate page
          if (nav === "schools") {
            window.location.href = "/admin-schools.html";
          } else if (nav === "users") {
            window.location.href = "/admin-users.html";
          } else if (nav === "billing") {
            window.location.href = "/admin-billing.html";
          } else if (nav === "settings") {
            window.location.href = "/admin-settings.html";
          }
        }
      });
    });

    // Logout
    DOM.logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleLogout();
    });

    // Event delegation for user role changes and actions
    document.getElementById("users-table-body").addEventListener("change", (e) => {
      if (e.target.matches(".user-role-select")) {
        handleRoleChange(e);
      }
    });

    document.getElementById("users-table-body").addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".user-action-btn");
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        const userId = actionBtn.dataset.userId;
        if (action === "delete") {
          // TODO: Implement user deletion
          console.log("Delete user:", userId);
        } else if (action === "reset-password") {
          // TODO: Implement password reset
          console.log("Reset password for user:", userId);
        }
      }
    });
  }

  // Initialize
  async function init() {
    const isAuthenticated = await checkAuth();
    if (!isAuthenticated) return;

    await fetchData();
    renderStats();
    renderSchools();
    renderUsers();
    renderBilling();
    setupEventListeners();
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();