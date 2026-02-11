import { useState, useEffect } from 'react';
import axios from 'axios';
import './NotificationBell.css';
import { API_URL } from '../config';

function NotificationBell({ onOpenPanel }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasNew, setHasNew] = useState(false);

  const loadUnreadCount = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/notifications/unread`);
      const newCount = response.data.length;

      // If count increased, show animation
      if (newCount > unreadCount) {
        setHasNew(true);
        setTimeout(() => setHasNew(false), 2000);
      }

      setUnreadCount(newCount);
    } catch (error) {
      console.error('Error loading notifications:', error);
    }
  };

  useEffect(() => {
    loadUnreadCount();

    // Poll for new notifications every 30 seconds
    const interval = setInterval(loadUnreadCount, 30000);

    // Listen for manual refresh events (e.g., when "mark all read" is clicked)
    const handleRefresh = () => loadUnreadCount();
    window.addEventListener('notifications-updated', handleRefresh);

    return () => {
      clearInterval(interval);
      window.removeEventListener('notifications-updated', handleRefresh);
    };
  }, []);

  return (
      <button
          className={`notification-bell ${hasNew ? 'has-new' : ''}`}
          onClick={onOpenPanel}
          title="Notifications"
      >
        <span className="bell-icon">🔔</span>
        {unreadCount > 0 && (
            <span className="notification-badge">{unreadCount}</span>
        )}
      </button>
  );
}

export default NotificationBell;