//! Reusable cache machinery shared by the desktop app and folio-server.
//!
//! `LruCache` is the in-memory LRU (moved here from the app crate);
//! `ManagedCache` + adapters arrive in later tasks.

/// A simple LRU cache that bundles the data map and access order in a single
/// structure, so only one Mutex is needed. This eliminates the risk of lock
/// poisoning or inversion that arises from guarding the map and order with
/// separate Mutexes.
pub struct LruCache<V> {
    entries: std::collections::HashMap<String, V>,
    sizes: std::collections::HashMap<String, usize>,
    order: Vec<String>,
    capacity: usize,
    max_bytes: usize,
    current_bytes: usize,
}

impl<V> LruCache<V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            sizes: std::collections::HashMap::new(),
            order: Vec::new(),
            capacity,
            max_bytes: 0, // 0 = no memory limit
            current_bytes: 0,
        }
    }

    /// Set maximum total byte size for the cache (#52).
    pub fn set_max_bytes(&mut self, bytes: usize) {
        self.max_bytes = bytes;
    }

    /// Current total tracked byte size.
    pub fn total_bytes(&self) -> usize {
        self.current_bytes
    }

    /// Number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Move an existing key to the most-recently-used position.
    pub fn touch(&mut self, key: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push(key.to_string());
    }

    /// Evict least-recently-used entries until both count and memory limits are satisfied.
    fn evict_if_needed(&mut self) {
        while self.entries.len() >= self.capacity
            || (self.max_bytes > 0 && self.current_bytes > self.max_bytes)
        {
            if let Some(oldest) = self.order.first().cloned() {
                self.entries.remove(&oldest);
                if let Some(size) = self.sizes.remove(&oldest) {
                    self.current_bytes = self.current_bytes.saturating_sub(size);
                }
                self.order.remove(0);
            } else {
                self.entries.clear();
                self.sizes.clear();
                self.current_bytes = 0;
                break;
            }
        }
    }

    /// Insert a key-value pair, evicting the least-recently-used entry when at capacity.
    pub fn insert(&mut self, key: String, value: V) {
        if self.entries.contains_key(&key) {
            self.touch(&key);
            self.entries.insert(key, value);
            return;
        }
        self.evict_if_needed();
        self.entries.insert(key.clone(), value);
        self.order.push(key);
    }

    /// Insert with explicit byte size tracking (#52).
    pub fn insert_with_size(&mut self, key: String, value: V, size_bytes: usize) {
        if self.entries.contains_key(&key) {
            // Update size tracking for existing entry
            if let Some(old_size) = self.sizes.get(&key) {
                self.current_bytes = self.current_bytes.saturating_sub(*old_size);
            }
            self.touch(&key);
            self.entries.insert(key.clone(), value);
            self.sizes.insert(key, size_bytes);
            self.current_bytes += size_bytes;
            return;
        }
        self.current_bytes += size_bytes;
        self.evict_if_needed();
        self.entries.insert(key.clone(), value);
        self.sizes.insert(key.clone(), size_bytes);
        self.order.push(key);
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries.get_mut(key)
    }

    pub fn remove(&mut self, key: &str) {
        self.entries.remove(key);
        if let Some(size) = self.sizes.remove(key) {
            self.current_bytes = self.current_bytes.saturating_sub(size);
        }
        self.order.retain(|k| k != key);
    }

    /// Drop every entry and reset byte accounting. Capacity and byte
    /// limits are configuration, not contents — they survive a clear.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.sizes.clear();
        self.order.clear();
        self.current_bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // #52: PDF cache memory limits (moved from src-tauri commands.rs)
    #[test]
    fn lru_cache_memory_tracking() {
        let mut cache = LruCache::<String>::new(100); // high count limit
        cache.set_max_bytes(100); // but low memory limit

        // Each entry is ~10 bytes
        cache.insert_with_size("a".to_string(), "0123456789".to_string(), 10);
        cache.insert_with_size("b".to_string(), "0123456789".to_string(), 10);
        assert_eq!(cache.total_bytes(), 20);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn lru_cache_memory_eviction() {
        let mut cache = LruCache::<String>::new(100);
        cache.set_max_bytes(25); // evict when over 25 bytes

        cache.insert_with_size("a".to_string(), "0123456789".to_string(), 10);
        cache.insert_with_size("b".to_string(), "0123456789".to_string(), 10);
        cache.insert_with_size("c".to_string(), "0123456789".to_string(), 10);

        // "a" should have been evicted to stay under 25 bytes
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_some() || cache.get("c").is_some());
        assert!(cache.total_bytes() <= 25);
    }

    #[test]
    fn clear_resets_entries_and_bytes() {
        let mut cache = LruCache::<String>::new(10);
        cache.set_max_bytes(1000);
        cache.insert("plain".to_string(), "v".to_string());
        cache.insert_with_size("sized".to_string(), "v".to_string(), 42);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.total_bytes(), 42);

        cache.clear();

        assert!(cache.is_empty());
        assert_eq!(cache.total_bytes(), 0);
        // Still usable after clear
        cache.insert("again".to_string(), "v".to_string());
        assert_eq!(cache.len(), 1);
    }
}
