import { connectionLabels } from '../utils/colorSystem';

export default function FiltersPanel({
  filters,
  setFilters,
  subjects,
  clusters,
  connectionTypes,
}) {
  const toggleConnection = (type) => {
    const next = new Set(filters.connectionTypes);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    setFilters({ ...filters, connectionTypes: next });
  };

  return (
    <div className="panel filters-panel">
      <h3>Filters</h3>

      <label>Search archive</label>
      <input
        type="text"
        placeholder="Title, keyword, subject"
        value={filters.searchQuery || ''}
        onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
      />

      <label className="filter-label">
        Edge threshold: <strong>{filters.minWeight.toFixed(2)}</strong>
      </label>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={filters.minWeight}
        aria-label="Minimum edge weight threshold"
        onChange={(e) => setFilters({ ...filters, minWeight: Number(e.target.value) })}
      />
      <small className="filter-hint">
        Hides connections below this similarity score. Raise to see only strong links.
      </small>

      <label>Connection Type</label>
      <div className="chips">
        {connectionTypes.map((type) => (
          <button
            type="button"
            key={type}
            className={filters.connectionTypes.has(type) ? 'chip active' : 'chip'}
            onClick={() => toggleConnection(type)}
          >
            {connectionLabels[type] || type}
          </button>
        ))}
      </div>

      <label>Subject</label>
      <select
        value={filters.subject}
        onChange={(e) => setFilters({ ...filters, subject: e.target.value })}
      >
        <option value="">All Subjects</option>
        {subjects.map((subject) => (
          <option key={subject} value={subject}>
            {subject}
          </option>
        ))}
      </select>

      <label>Competition Group</label>
      <select
        value={filters.cluster}
        onChange={(e) => setFilters({ ...filters, cluster: e.target.value })}
      >
        <option value="">All Competitions</option>
        {clusters.map((cluster) => (
          <option key={cluster.value || String(cluster)} value={cluster.value || String(cluster)}>
            {cluster.label || `Cluster ${cluster}`} {cluster.count ? `(${cluster.count})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
