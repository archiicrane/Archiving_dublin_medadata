import { connectionColors, connectionLabels } from '../utils/colorSystem';

export default function Legend() {
  return (
    <div className="legend">
      <h3>Connection Legend</h3>
      {Object.entries(connectionColors).map(([type, color]) => (
        <div key={type} className="legend-item">
          <span className="legend-swatch" style={{ backgroundColor: color }} />
          <span>{connectionLabels[type]}</span>
        </div>
      ))}
    </div>
  );
}
