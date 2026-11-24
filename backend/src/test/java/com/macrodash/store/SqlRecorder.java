package com.macrodash.store;

import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 시험용 — 테스트 DB에 보낸 SQL 문장을 차례로 적는 DataSource(성능 개선 2차 QA-991·992: '두 번째 호출에는 이 질의가 나가지 않음'을 시간이 아니라 꼴로 봄).
 * 준비한 문장({@code prepareStatement})과 바로 보낸 문장({@code Statement.execute*})을 모두 적습니다. 의존성 없이 JDK 프록시로 감쌉니다.
 */
public final class SqlRecorder {

    private final List<String> statements = new CopyOnWriteArrayList<>();
    private final DataSource dataSource;

    public SqlRecorder(String url, String user, String password) {
        DriverManagerDataSource target = new DriverManagerDataSource(url, user, password);
        this.dataSource = (DataSource) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    Object result = invoke(target, method, args);
                    return result instanceof Connection connection ? connection(connection) : result;
                });
    }

    /** 이 DataSource로 연 연결의 문장이 적힙니다. */
    public DataSource dataSource() {
        return dataSource;
    }

    /** 지금까지 적힌 문장(보낸 차례). */
    public List<String> statements() {
        return List.copyOf(statements);
    }

    /** {@code fragment}가 든 문장 수. */
    public long count(String fragment) {
        return statements.stream().filter(sql -> sql.contains(fragment)).count();
    }

    public void clear() {
        statements.clear();
    }

    private Connection connection(Connection target) {
        return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
            if (method.getName().startsWith("prepare") && args != null && args.length > 0 && args[0] instanceof String sql) {
                statements.add(sql);
            }
            Object result = invoke(target, method, args);
            return result instanceof Statement statement && method.getName().equals("createStatement") ? statement(statement) : result;
        });
    }

    private Statement statement(Statement target) {
        return (Statement) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Statement.class}, (proxy, method, args) -> {
            if (method.getName().startsWith("execute") && args != null && args.length > 0 && args[0] instanceof String sql) {
                statements.add(sql);
            }
            return invoke(target, method, args);
        });
    }

    private static Object invoke(Object target, java.lang.reflect.Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }
}
