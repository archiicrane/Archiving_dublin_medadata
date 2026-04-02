import { connectionColors, connectionLabels } from '../utils/colorSystem';

export default function Legend() {
  return (
    <div className="legend">
      <h3>Link Meanings</h3>
      <p className="subtle legend-intro">Colors show why two drawings are connected.</p>
      {Object.entries(connectionColors).map(([type, color]) => (
        <div key={type} className="legend-item">
          <span className="legend-swatch" style={{ backgroundColor: color }} />
          <span>{connectionLabels[type]}</span>
        </div>
      ))}
    </div>
  );
}
