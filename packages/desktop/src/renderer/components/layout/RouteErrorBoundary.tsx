/**
 * Error boundary that catches render errors from lazy-loaded route components.
 * Prevents the permanent spinner state when a dynamic import() never resolves
 * or when a page component throws during initialization.
 */
import React from 'react';
import { Button, Result } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class RouteErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '24px',
          }}
        >
          <Result
            status='error'
            title='Page failed to load'
            subTitle={this.state.error?.message || 'An unexpected error occurred while loading this page.'}
            extra={
              <Button type='primary' icon={<Refresh />} onClick={this.handleRetry}>
                Retry
              </Button>
            }
          />
        </div>
      );
    }

    return this.props.children;
  }
}
