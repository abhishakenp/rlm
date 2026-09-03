// Deadman switch remedies
// STRANDED is intentionally NOT included - it's a dead-end condition

const remedies = {
  // Add other conditions here as needed
  // Example:
  // DISCONNECTED: async () => { /* reconnection logic */ },
};

export default {
  remedies,
  remedyMap: remedies,
  
  // Helper function to check if a condition has a remedy
  hasRemedy(condition) {
    return condition in remedies;
  },
  
  // Get remedy for a condition
  async getRemedy(condition) {
    return remedies[condition] ?? null;
  }
};
