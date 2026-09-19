// School Dashboard JavaScript
// FastLectures School Panel - Handles student management, billing, and settings

(function() {
  "use strict";

  const API_BASE = "/api/school";

  // State management
  let state = {
    school: {},
    students: [],
    billing: {},
    isLoading: false
  };

  // DOM Elements
  const DOM = {
    // Stats
    statTotalStudents: document.getElementById("stat-total-students"),
    statMonthlyCost: document.getElementById("stat-monthly-cost"),
    statRebate: document.getElementById("stat-rebate"),
    statLicenses: document.getElementById("stat-licenses"),

    // Students
    studentsTableBody: document.getElementById("students-table-body"),
    emptyStudents: document.getElementById("empty-students"),
    addStudentModal: document.getElementById("add-student-modal"),
    deleteStudentModal: document.getElementById("delete-student-modal"),
    addStudentForm: document.getElementById("add-student-form"),
    deleteStudentName: document.getElementById("delete-student-name"),
    closeAddStudentModal: document.getElementById("close-add-student-modal"),
    closeDeleteStudentModal: document.getElementById("close-delete-student-modal"),
    cancelDeleteStudent: document.getElementById("cancel-delete-student"),
    confirmDeleteStudent: document.getElementById("confirm-delete-student"),
    addStudentError: document.getElementById("add-student-error"),
    deleteStudentError: document.getElementById("delete-student-error"),

    // Billing
    billingTotalAccounts: document.getElementById("billing-total-accounts"),
    billingTotalCost: document.getElementById("billing-total-cost"),
    billingRebateApplied: document.getElementById("billing-rebate-applied"),
    billingNetCost: document.getElementById("billing-net-cost"),

    // Settings
    schoolSettingsForm: document.getElementById("school-settings-form"),
    notificationSettingsForm: document.getElementById("notification-settings-form"),
    saveSettingsBtn: document.getElementById("save-settings-btn"),

    // Navigation
    navItems: document.querySelectorAll(".school-nav-item"),
    logoutBtn: document.getElementById("school-logout-btn")
  };

  // Check if user is school admin
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
      if (!data.user || data.user.role !== "school_admin") {
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
      // Fetch school data
      const schoolResp = await fetch(`${API_BASE}`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (schoolResp.ok) {
        state.school = await schoolResp.json();
      }

      // Fetch students
      const studentsResp = await fetch(`${API_BASE}/students`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (studentsResp.ok) {
        state.students = await studentsResp.json();
      }

      // Fetch billing
      const billingResp = await fetch(`${API_BASE}/billing`, {
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });
      if (billingResp.ok) {
        state.billing = await billingResp.json();
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      state.isLoading = false;
    }
  }

  // Render students table
  function renderStudents() {
    if (state.students.length === 0) {
      DOM.studentsTableBody.style.display = "none";
      DOM.emptyStudents.style.display = "flex";
      return;
    }

    DOM.studentsTableBody.style.display = "table-row-group";
    DOM.emptyStudents.style.display = "none";

    DOM.studentsTableBody.innerHTML = state.students.map(student => {
      const statusClass = student.is_active ? "status-active" : "status-inactive";
      const statusText = student.is_active ? "Active" : "Inactive";
      const enrolled = new Date(student.created_at).toLocaleDateString();

      return `
        <tr data-student-id="${student.id}">
          <td>
            <span class="student-name">${escapeHtml(student.name || student.email.split("@")[0])}</span>
          </td>
          <td>${escapeHtml(student.email)}</td>
          <td><span class="user-status ${statusClass}">${statusText}</span></td>
          <td>${enrolled}</td>
          <td>
            <button class="btn-ghost student-action-btn" type="button" data-action="reset-password" data-student-id="${student.id}" aria-label="Reset password">
              Reset password
            </button>
            <button class="btn-danger student-action-btn" type="button" data-action="remove" data-student-id="${student.id}" aria-label="Remove student">
              Remove
            </button>
          </td>
        </tr>
      `;
    }).join("");
  }

  // Render stats
  function renderStats() {
    const studentCount = state.students.length;
    const monthlyCost = state.billing?.monthly_cost || (studentCount * 20);
    const rebate = state.billing?.rebate || (studentCount * 2);
    const netCost = monthlyCost - rebate;
    const licenses = state.billing?.total_licenses || Math.max(50, studentCount + 10);
    const remaining = Math.max(0, licenses - studentCount);

    DOM.statTotalStudents.textContent = studentCount;
    DOM.statMonthlyCost.textContent = `$${monthlyCost.toFixed(2)}`;
    DOM.statRebate.textContent = `$${rebate.toFixed(2)}`;
    DOM.statLicenses.textContent = remaining;
  }

  // Render billing
  function renderBilling() {
    const billing = state.billing || {};
    const studentCount = state.students.length;
    const totalCost = billing.total_cost || (studentCount * 20);
    const rebateApplied = billing.rebate_applied || (studentCount * 2);
    const netCost = totalCost - rebateApplied;
    const totalAccounts = billing.total_accounts || studentCount;

    DOM.billingTotalAccounts.textContent = totalAccounts;
    DOM.billingTotalCost.textContent = `$${totalCost.toFixed(2)}`;
    DOM.billingRebateApplied.textContent = `$${rebateApplied.toFixed(2)}`;
    DOM.billingNetCost.textContent = `$${netCost.toFixed(2)}`;
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Add student
  async function handleAddStudent(e) {
    e.preventDefault();

    const form = e.target;
    const name = document.getElementById("add-student-name").value.trim();
    const email = document.getElementById("add-student-email").value.trim();
    const grade = document.getElementById("add-student-grade").value.trim() || undefined;

    DOM.addStudentError.hidden = true;

    try {
      const response = await fetch(`${API_BASE}/students`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify({ name, email, grade })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to add student");
      }

      await fetchData();
      renderStudents();
      renderStats();
      renderBilling();
      DOM.addStudentModal.close();
      form.reset();
    } catch (err) {
      DOM.addStudentError.textContent = err.message || "Failed to add student";
      DOM.addStudentError.hidden = false;
    }
  }

  // Open student deletion modal
  function openDeleteModal(studentId) {
    const student = state.students.find(s => s.id === studentId);
    if (!student) return;

    DOM.deleteStudentName.textContent = `Remove ${escapeHtml(student.name || student.email)}?`;
    DOM.deleteStudentError.hidden = true;

    DOM.deleteStudentModal.showModal();
    DOM.confirmDeleteStudent.dataset.studentId = studentId;
  }

  // Delete student
  async function handleDeleteStudent() {
    const studentId = DOM.confirmDeleteStudent.dataset.studentId;
    if (!studentId) return;

    try {
      const response = await fetch(`${API_BASE}/students/${studentId}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "accept": "application/json" }
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove student");
      }

      await fetchData();
      renderStudents();
      renderStats();
      renderBilling();
      DOM.deleteStudentModal.close();
    } catch (err) {
      DOM.deleteStudentError.textContent = err.message || "Failed to remove student";
      DOM.deleteStudentError.hidden = false;
    }
  }

  // Save settings
  async function handleSaveSettings(e) {
    e.preventDefault();

    const form = e.target;
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    try {
      const response = await fetch(`${API_BASE}/settings`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to save settings");
      }

      const originalText = DOM.saveSettingsBtn.textContent;
      DOM.saveSettingsBtn.textContent = "Saved";
      setTimeout(() => {
        DOM.saveSettingsBtn.textContent = originalText;
      }, 1500);
    } catch (err) {
      console.error("Failed to save settings:", err);
      alert("Failed to save settings. Please try again.");
    }
  }

  // Save notification settings
  async function handleSaveNotifications(e) {
    e.preventDefault();

    const data = {
      student_signup: document.getElementById("notif-student-signup").checked,
      billing: document.getElementById("notif-billing").checked,
      reports: document.getElementById("notif-reports").checked
    };

    try {
      const response = await fetch(`${API_BASE}/settings/notifications`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(data)
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Failed to save notification settings");
      }

      const originalText = DOM.saveSettingsBtn.textContent;
      DOM.saveSettingsBtn.textContent = "Saved";
      setTimeout(() => {
        DOM.saveSettingsBtn.textContent = originalText;
      }, 1500);
    } catch (err) {
      console.error("Failed to save notification settings:", err);
      alert("Failed to save notification settings. Please try again.");
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
    // Add student modal
    document.getElementById("add-student-btn").addEventListener("click", () => {
      DOM.addStudentModal.showModal();
      DOM.addStudentForm.addEventListener("submit", handleAddStudent, { once: true });
    });

    // Close modal buttons
    DOM.closeAddStudentModal.addEventListener("click", () => {
      DOM.addStudentModal.close();
    });

    // Delete student modal
    DOM.cancelDeleteStudent.addEventListener("click", () => {
      DOM.deleteStudentModal.close();
    });

    DOM.closeDeleteStudentModal.addEventListener("click", () => {
      DOM.deleteStudentModal.close();
    });

    DOM.confirmDeleteStudent.addEventListener("click", (e) => {
      e.preventDefault();
      handleDeleteStudent();
    });

    // Settings forms
    DOM.schoolSettingsForm.addEventListener("submit", handleSaveSettings);
    DOM.notificationSettingsForm.addEventListener("submit", handleSaveNotifications);

    // Navigation
    DOM.navItems.forEach(item => {
      item.addEventListener("click", (e) => {
        const nav = item.dataset.nav;
        if (nav === "students") {
          DOM.navItems.forEach(i => i.classList.remove("school-nav-item-active"));
          item.classList.add("school-nav-item-active");
        } else if (nav === "logout") {
          handleLogout();
        } else {
          // Navigate to appropriate page
          if (nav === "billing") {
            window.location.href = "/school-billing.html";
          } else if (nav === "settings") {
            window.location.href = "/school-settings.html";
          } else if (nav === "teachers") {
            window.location.href = "/teacher-tools.html";
          }
        }
      });
    });

    // Logout
    DOM.logoutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      handleLogout();
    });

    // Student actions
    document.getElementById("students-table-body").addEventListener("click", (e) => {
      const actionBtn = e.target.closest(".student-action-btn");
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        const studentId = actionBtn.dataset.studentId;
        if (action === "remove") {
          openDeleteModal(studentId);
        } else if (action === "reset-password") {
          // TODO: Implement password reset
          console.log("Reset password for student:", studentId);
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
    renderStudents();
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