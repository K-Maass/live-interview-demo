import { useCopilotController } from './copilot/useCopilotController';
import { CopilotApplication } from './copilot/CopilotApplication';
import './copilot/copilot.css';
export default function App() {
  const controller = useCopilotController();
  return <CopilotApplication controller={controller} />;
}
