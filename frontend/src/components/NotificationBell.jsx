import { useState, useEffect } from 'react';
import axios from 'axios';
import './NotificationBell.css';
import { API_URL } from '../config';

function NotificationBell({ onOpenPanel }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    loadUnreadCount();

    // Poll for new notifications every 30 seconds
    const interval = setInterval(loadUnreadCount, 30000);

    return () => clearInterval(interval);
  }, []);

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