import { useState, useEffect } from 'react';
import axios from 'axios';
import './NotificationPanel.css';
import { API_URL } from '../config';

function NotificationPanel({ isOpen, onClose }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      loadNotifications();
    }
  }, [isOpen]);

  const loadNotifications = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API_URL}/api/notifications?limit=50`);
      setNotifications(response.data);
    } catch (error) {
      console.error('Error loading notifications:', error);
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (id) => {
    try {
      await axios.patch(`${API_URL}/api/notifications/${id}/read`);
      setNotifications(prev =>
          prev.map(n => n._id === id ? { ...n, read: true } : n)
      );
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  };

  const markAllAsRead = async () => {
    try {
      await axios.post(`${API_URL}/api/notifications/read-all`);
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      // Notify the bell to refresh
      window.dispatchEvent(new Event('notifications-updated'));
    } catch (error) {
      console.error('Error marking all as read:', error);
    }
  };

  const deleteNotification = async (id) => {
    // Confirmation dialog before delete
    if (!window.confirm('Notification wirklich löschen?')) {
      return;
    }
    
    try {
      await axios.delete(`${API_URL}/api/notifications/${id}`);
      setNotifications(prev => prev.filter(n => n._id !== id));
      // Notify the bell to refresh
      window.dispatchEvent(new Event('notifications-updated'));
    } catch (error) {
      console.error('Error deleting notification:', error);
    }
  };

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case 'high': return 'urgency-high';
      case 'medium': return 'urgency-medium';
      default: return 'urgency-low';
    }
  };

  const formatTime = (date) => {
    const now = new Date();
    const notifDate = new Date(date);
    const diffMs = now - notifDate;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return notifDate.toLocaleDateString();
  };

  if (!isOpen) return null;

  return (
      <div className="notification-panel-overlay" onClick={onClose}>
        <div className="notification-panel" onClick={(e) => e.stopPropagation()}>
          <div className="panel-header">
            <h3>💌 Notifications</h3>
            <div className="panel-header-actions">
              {notifications.some(n => !n.read) && (
                  <button onClick={markAllAsRead} className="btn-mark-all">
                    Mark all read
                  </button>
              )}
              <button onClick={onClose} className="btn-close">✕</button>
            </div>
          </div>

          <div className="panel-content">
            {loading ? (
                <div className="loading-state">Loading notifications...</div>
            ) : notifications.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon">📭</span>
                  <p>No notifications yet</p>
                  <span className="empty-hint">
                When Levo wants to reach you, you'll see messages here
              </span>
                </div>
            ) : (
                <div className="notifications-list">
                  {notifications.map(notification => (
                      <div
                          key={notification._id}
                          className={`notification-item ${!notification.read ? 'unread' : ''} ${getUrgencyColor(notification.urgency)}`}
                          onClick={() => !notification.read && markAsRead(notification._id)}
                      >
                        <div className="notification-avatar">
                          {notification.personaAvatar || '🤖'}
                        </div>
                        <div className="notification-content">
                          <div className="notification-header-row">
                            <span className="notification-sender">{notification.personaName}</span>
                            <span className="notification-time">{formatTime(notification.createdAt)}</span>
                          </div>
                          <div className="notification-message">{notification.message}</div>
                        </div>
                        <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteNotification(notification._id);
                            }}
                            className="btn-delete"
                            title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                  ))}
                </div>
            )}
          </div>
        </div>
      </div>
  );
}

export default NotificationPanel;