import { ReactWidget } from '@jupyterlab/apputils';
import { NotebookPanel } from '@jupyterlab/notebook';

import React, { useState, useEffect } from 'react';

type StatusType = 'error' | 'idle' | 'busy';

interface IStatusIndicatorProps {
  notebookPanel: NotebookPanel;
}

function StatusIndicator({ notebookPanel }: IStatusIndicatorProps) {
  const [currentStatus, setCurrentStatus] = useState<StatusType>('busy');

  useEffect(() => {
    notebookPanel.sessionContext.statusChanged.connect((sender, status) => {
      if (status === 'busy') {
        setCurrentStatus('busy');
      } else if (status === 'idle') {
        setCurrentStatus('idle');
      } else if (status === 'dead') {
        setCurrentStatus('error');
      } else {
        setCurrentStatus('busy');
      }
    });
  }, [notebookPanel]);

  const statusClass = `status-indicator-${currentStatus}`;

  return (
    <div className={`status-indicator ${statusClass}`}>
      <div className="status-indicator-icon-container">
        {currentStatus === 'busy' && (
          <div className="status-indicator-spinner">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle
                className="status-indicator-spinner-track"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="status-indicator-spinner-path"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
          </div>
        )}

        {currentStatus === 'idle' && (
          <div className="status-indicator-success">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M8 12L11 15L16 9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}

        {currentStatus === 'error' && (
          <div className="status-indicator-error">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M15 9L9 15M9 9L15 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}

        {/* {currentStatus === 'busy' && (
          <div className="status-indicator-busy">
            <div className="status-indicator-busy-dot"></div>
            <div className="status-indicator-busy-dot"></div>
            <div className="status-indicator-busy-dot"></div>
          </div>
        )} */}
      </div>
    </div>
  );
}

export class StatusToolbarButton extends ReactWidget {
  constructor(private props: IStatusIndicatorProps) {
    super();
    this.addClass('jp-StatusToolbarButton');
  }

  render() {
    return <StatusIndicator {...this.props} />;
  }
}
