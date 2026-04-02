import { connectionColors, connectionLabels, thematicEdgeColors } from '../utils/colorSystem';

export default function Legend() {
  return (
    <div className="legend">
      <h3>Link Meanings</h3>
      <p className="subtle legend-intro">Node colors = competition/collection groups. Line colors = why drawings are related.</p>

      <div className="legend-theme-row">
        <span className="legend-swatch" style={{ backgroundColor: thematicEdgeColors.water }} />
        <span>Water-related connection</span>
      </div>
      <div className="legend-theme-row">
        <span className="legend-swatch" style={{ backgroundColor: thematicEdgeColors.vegetation }} />
        <span>Plants / vegetation connection</span>
      </div>
      <div className="legend-theme-row">
        <span className="legend-swatch" style={{ backgroundColor: thematicEdgeColors.topography }} />
        <span>Topography / terrain connection</span>
      </div>
      <div className="legend-theme-row">
        <span className="legend-swatch" style={{ backgroundColor: thematicEdgeColors.building }} />
        <span>Building / architecture connection</span>
      </div>

      {Object.entries(connectionColors).map(([type, color]) => (
        <div key={type} className="legend-item">
          <span className="legend-swatch" style={{ backgroundColor: color }} />
          <span>{connectionLabels[type]}</span>
        </div>
      ))}
    </div>
  );
}
